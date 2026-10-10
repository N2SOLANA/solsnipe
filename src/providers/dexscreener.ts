/**
 * Dexscreener client (§5.3, §9). Endpoints chosen per docs/PROVIDERS.md:
 * primary `/latest/dex/tokens/{mint}` (full multi-venue), `search` for
 * discovery, v1 as fallback. All HTTP via allowlisted allowedFetch.
 * Bounded retries with backoff + jitter; 429/timeout/5xx → error result,
 * never fake data.
 *
 * Precision note (review #8): provider numbers arrive as JS floats, so values
 * beyond 2^53 or with deep decimals are already approximate. We render them
 * as plain (non-exponent) decimal strings for storage and document the limit;
 * exact spend math happens later on bigint lamports, never on these strings.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { allowedFetch } from "../net/httpClient.js";
import { logger } from "../util/logger.js";
import {
  type FetchResult,
  type MarketDataProvider,
  NormalizedObservationSchema,
  type NormalizedObservation,
} from "./types.js";

const BASE = "https://api.dexscreener.com";
const MAX_MINTS_PER_REQUEST = 30;
export const RECORDER_VERSION = "m2.1";

// Strict decimal: optional sign (minus only), digits, optional fraction,
// no exponent, no hex, no whitespace. Separate from bare z.string() so the
// schema actually rejects "0x10", "NaN", "1e-7".
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function numToDecimal(n: unknown, notes: string[], field: string): string | null {
  if (n === undefined || n === null) return null; // missing ≠ zero
  if (typeof n !== "number") {
    notes.push(`${field}: non-numeric ${typeof n} rejected`);
    return null;
  }
  if (!Number.isFinite(n)) {
    notes.push(`${field}: non-finite rejected`);
    return null;
  }
  if (n < 0) {
    notes.push(`${field}: negative rejected`);
    return null;
  }
  // Plain (non-exponent) rendering: exponent forms like "1e-7" break
  // downstream decimal parsers. Precision beyond 2^53 is approximate (§note).
  if (n === 0) return "0";
  let s = String(n);
  if (/[eE]/.test(s)) {
    s = n.toFixed(18).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  if (!DECIMAL_RE.test(s)) {
    notes.push(`${field}: unrenderable "${s.slice(0, 32)}" rejected`);
    return null;
  }
  return s;
}

function strDecimal(s: string | undefined, notes: string[], field: string): string | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || !DECIMAL_RE.test(t)) {
    notes.push(`${field}: malformed "${s.slice(0, 32)}" rejected`);
    return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n)) {
    notes.push(`${field}: non-finite "${s.slice(0, 32)}" rejected`);
    return null;
  }
  if (n < 0) {
    notes.push(`${field}: negative rejected`);
    return null;
  }
  return t; // trimmed/normalized, not the raw input
}

/** priceChange may be negative; still must be finite and well-formed. */
function signedDecimal(s: unknown): string | null {
  if (s === undefined || s === null) return null;
  if (typeof s !== "number" && typeof s !== "string") return null;
  const t = String(s).trim();
  if (!DECIMAL_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? t : null;
}

function intCount(n: unknown, notes: string[], field: string): number | null {
  if (n === undefined || n === null) return null;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    notes.push(`${field}: invalid count rejected`);
    return null;
  }
  if (!Number.isInteger(n)) {
    notes.push(`${field}: fractional count ${n} floored`);
  }
  return Math.floor(n);
}

// Raw pair schema: structure is strict, but market SCALARS are unknown —
// one bad field (NaN, wrong type) must null that field with a note, never
// drop the whole pair (review critical #2). Converters narrow at field level.
const UnknownScalar = z.unknown().optional();

const RawTxns = z
  .object({
    buys: UnknownScalar,
    sells: UnknownScalar,
  })
  .partial()
  .optional();

const RawPairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  pairAddress: z.string(),
  baseToken: z.object({
    address: z.string(),
    name: z.string().optional(),
    symbol: z.string().optional(),
  }),
  quoteToken: z
    .object({ address: z.string(), symbol: z.string().optional() })
    .optional(),
  priceNative: z.string().optional(),
  priceUsd: z.string().optional(),
  txns: z
    .object({ m5: RawTxns, h1: RawTxns, h6: RawTxns, h24: RawTxns })
    .partial()
    .optional(),
  volume: z
    .object({ h24: UnknownScalar, h6: UnknownScalar, h1: UnknownScalar, m5: UnknownScalar })
    .partial()
    .optional(),
  priceChange: z
    .object({ m5: UnknownScalar, h1: UnknownScalar, h6: UnknownScalar, h24: UnknownScalar })
    .partial()
    .optional(),
  liquidity: z
    .object({ usd: UnknownScalar, base: UnknownScalar, quote: UnknownScalar })
    .partial()
    .optional(),
  fdv: UnknownScalar,
  marketCap: UnknownScalar,
  pairCreatedAt: UnknownScalar,
});

type RawPair = z.infer<typeof RawPairSchema>;

const MIN_PAIR_CREATED_AT_MS = Date.UTC(2020, 0, 1); // range-check unit (ms, not s)

/** Stable stringify: sorted keys, so identical content hashes identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function normalizePair(
  rawItem: unknown,
  source: string,
  observedAt: number,
  latencyMs: number,
): { observation: NormalizedObservation; dropped: string | null } {
  const itemParse = RawPairSchema.safeParse(rawItem);
  if (!itemParse.success) {
    return {
      observation: null as never,
      dropped: `pair schema: ${itemParse.error.issues.map((i) => i.message).join("; ").slice(0, 200)}`,
    };
  }
  const raw = itemParse.data;
  const notes: string[] = [];
  const txns = (w: "h24" | "h6" | "h1" | "m5") => raw.txns?.[w];
  const priceChangeH24 =
    raw.priceChange?.h24 === undefined ? null : signedDecimal(raw.priceChange.h24);
  if (raw.priceChange?.h24 !== undefined && priceChangeH24 === null) {
    notes.push("priceChange.h24: malformed rejected");
  }
  let pairCreatedAt: number | null = null;
  if (raw.pairCreatedAt === undefined || raw.pairCreatedAt === null) {
    pairCreatedAt = null;
  } else if (
    typeof raw.pairCreatedAt !== "number" ||
    !Number.isFinite(raw.pairCreatedAt) ||
    raw.pairCreatedAt < MIN_PAIR_CREATED_AT_MS ||
    raw.pairCreatedAt > observedAt + 3_600_000
  ) {
    // Wrong type, or out of plausible range: probably wrong unit (seconds)
    // or clock skew.
    notes.push(`pairCreatedAt: implausible ${String(raw.pairCreatedAt).slice(0, 24)} rejected`);
    pairCreatedAt = null;
  } else {
    pairCreatedAt = Math.floor(raw.pairCreatedAt);
  }
  const candidate = {
    mint: raw.baseToken.address,
    pairAddress: raw.pairAddress,
    dexId: raw.dexId,
    chainId: raw.chainId,
    quoteMint: raw.quoteToken?.address ?? null,
    priceUsd: strDecimal(raw.priceUsd, notes, "priceUsd"),
    priceNative: strDecimal(raw.priceNative, notes, "priceNative"),
    liquidityUsd: numToDecimal(raw.liquidity?.usd, notes, "liquidity.usd"),
    liquidityBase: numToDecimal(raw.liquidity?.base, notes, "liquidity.base"),
    liquidityQuote: numToDecimal(raw.liquidity?.quote, notes, "liquidity.quote"),
    volumeH24: numToDecimal(raw.volume?.h24, notes, "volume.h24"),
    volumeH6: numToDecimal(raw.volume?.h6, notes, "volume.h6"),
    volumeH1: numToDecimal(raw.volume?.h1, notes, "volume.h1"),
    volumeM5: numToDecimal(raw.volume?.m5, notes, "volume.m5"),
    txnsH24Buys: intCount(txns("h24")?.buys, notes, "txns.h24.buys"),
    txnsH24Sells: intCount(txns("h24")?.sells, notes, "txns.h24.sells"),
    priceChangeH24,
    marketCap: numToDecimal(raw.marketCap, notes, "marketCap"),
    fdv: numToDecimal(raw.fdv, notes, "fdv"),
    pairCreatedAt,
    observedAt,
    source,
    latencyMs: Math.max(0, Math.floor(latencyMs)),
    rawHash: createHash("sha256").update(stableStringify(rawItem)).digest("hex"),
    validationNotes: notes,
  };
  // Validate our OWN output: a converter bug must throw here, not reach the DB.
  const outParse = NormalizedObservationSchema.safeParse(candidate);
  if (!outParse.success) {
    return {
      observation: null as never,
      dropped: `internal: ${outParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 200)}`,
    };
  }
  return { observation: outParse.data, dropped: null };
}

/**
 * Lenient envelope parse: `pairs` may be null (unknown mint → no data),
 * missing, or contain individually-bad items. Good pairs survive; bad ones
 * are counted with reasons. Never throws.
 */
export function parsePairs(
  json: unknown,
  source: string,
  observedAt: number,
  latencyMs: number,
): { observations: NormalizedObservation[]; dropped: string[] } {
  const observations: NormalizedObservation[] = [];
  const dropped: string[] = [];
  if (json === null || typeof json !== "object") {
    return { observations, dropped: ["envelope: not an object"] };
  }
  const pairs = (json as { pairs?: unknown }).pairs;
  if (pairs === null || pairs === undefined) return { observations, dropped: [] };
  if (!Array.isArray(pairs)) return { observations, dropped: ["envelope: pairs not an array"] };
  // Dedupe within a poll: same pair twice → keep first, count the drop.
  const seen = new Set<string>();
  for (const item of pairs) {
    const { observation, dropped: reason } = normalizePair(item, source, observedAt, latencyMs);
    if (reason !== null) {
      dropped.push(reason);
      continue;
    }
    const key = `${observation.mint}|${observation.pairAddress}`;
    if (seen.has(key)) {
      dropped.push(`duplicate pair in poll: ${key.slice(0, 100)}`);
      continue;
    }
    seen.add(key);
    observations.push(observation);
  }
  return { observations, dropped };
}

/** Validate + dedupe a mint list; throws on empty-after-validation. */
/** Validate + dedupe a mint list; throws on invalid entries or empty result. */
export function cleanMintList(mints: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mints) {
    const t = m.trim();
    if (t === "") continue;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) {
      throw new Error(`invalid mint (not base58 32-44 chars): "${t.slice(0, 20)}..."`);
    }
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  if (out.length === 0) {
    throw new Error("mint list is empty after validation (refusing to poll nothing)");
  }
  return out;
}

export function chunkMints(mints: string[], size: number = MAX_MINTS_PER_REQUEST): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += size) chunks.push(mints.slice(i, i + size));
  return chunks;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function jitter(ms: number): number {
  return Math.floor(ms * (0.5 + Math.random() * 0.5));
}

function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  return null;
}

export interface GetResult {
  status: number;
  json: unknown;
  latencyMs: number; // total elapsed across attempts (honest staleness)
  rawBody: string | null; // first-200 body truncated, for audit
  attempts: number;
}

export class RetryableError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(message: string, status: number | null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "RetryableError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * GET with bounded retries. Retries ONLY timeout/network/429/5xx.
 * Non-retryable (4xx other than 429, bad URL, programmer errors) throw
 * immediately. On exhaustion throws RetryableError carrying the last status.
 */
export async function getJson(url: string, signal?: AbortSignal): Promise<GetResult> {
  const t0 = Date.now();
  let lastStatus: number | null = null;
  let lastRetryAfter: number | null = null;
  let lastErr: unknown = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts = attempt + 1;
    if (signal?.aborted) throw new Error("aborted");
    try {
      const res = await allowedFetch(
        url,
        signal === undefined ? { timeoutMs: 15_000 } : { timeoutMs: 15_000, signal },
      );
      lastStatus = res.status;
      if (res.status === 429) {
        lastRetryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
        await res.body?.cancel().catch(() => {});
        throw new RetryableError(`HTTP 429`, 429, lastRetryAfter);
      }
      if (res.status >= 500 && res.status < 600) {
        await res.body?.cancel().catch(() => {});
        throw new RetryableError(`HTTP ${res.status}`, res.status);
      }
      // Non-2xx, non-retryable (e.g. 400, 404): parse body once, no retry.
      const text = await res.text();
      const rawBody = res.status === 200 ? text.slice(0, 20_000) : null;
      try {
        return {
          status: res.status,
          json: JSON.parse(text) as unknown,
          latencyMs: Date.now() - t0,
          rawBody,
          attempts,
        };
      } catch {
        // Non-JSON body: retryable only on 2xx (provider glitch); a 4xx with
        // HTML body is a client error — surface immediately.
        if (res.status >= 200 && res.status < 300) {
          throw new RetryableError(`non-JSON 2xx body (${text.length} bytes)`, res.status);
        }
        throw new Error(`non-JSON response (HTTP ${res.status}, ${text.length} bytes)`);
      }
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof RetryableError ||
        (err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError" || /network|fetch failed|aborted/i.test(err.message)));
      if (!retryable || attempt === MAX_RETRIES) break;
      const backoff =
        err instanceof RetryableError && err.retryAfterMs !== null
          ? err.retryAfterMs
          : Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const wait = jitter(backoff);
      logger.warn("dexscreener_retry", {
        attempt: attempt + 1,
        max: MAX_RETRIES + 1,
        backoffMs: wait,
        status: err instanceof RetryableError ? err.status : null,
      });
      await new Promise((r, rej) => {
        const t = setTimeout(r, wait);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        }, { once: true });
      }).catch(() => {
        throw new Error("aborted");
      });
    }
  }
  const latencyMs = Date.now() - t0;
  if (lastErr instanceof RetryableError) {
    (lastErr as { latencyMs?: number }).latencyMs = latencyMs;
    throw lastErr;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class DexscreenerProvider implements MarketDataProvider {
  readonly name = "dexscreener";

  async fetchPairsByMints(mints: string[], signal?: AbortSignal): Promise<FetchResult> {
    const fetchedAt = Date.now();
    const t0 = Date.now();
    let cleaned: string[];
    try {
      cleaned = cleanMintList(mints);
    } catch (err) {
      return {
        observations: [],
        statusCode: null,
        latencyMs: Date.now() - t0,
        fetchedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (cleaned.length === 0) {
      return { observations: [], statusCode: null, latencyMs: Date.now() - t0, fetchedAt, error: null };
    }
    if (mints.length === 0) {
      return { observations: [], statusCode: null, latencyMs: 0, fetchedAt, error: null };
    }
    const observations: NormalizedObservation[] = [];
    const dropped: string[] = [];
    let lastStatus: number | null = null;
    let lastError: string | null = null;
    let attempts = 0;
    for (const chunk of chunkMints(cleaned)) {
      // Encode each mint, join with literal commas (commas are delimiters).
      const url = `${BASE}/latest/dex/tokens/${chunk.map(encodeURIComponent).join(",")}`;
      try {
        const { status, json, latencyMs, rawBody, attempts: a } = await getJson(url, signal);
        attempts += a;
        lastStatus = status;
        const observedAt = Date.now();
        const parsed = parsePairs(json, "dexscreener:tokens", observedAt, latencyMs);
        observations.push(...parsed.observations);
        dropped.push(...parsed.dropped);
        void rawBody;
      } catch (err) {
        attempts += 1;
        lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof RetryableError && err.status !== null) lastStatus = err.status;
        logger.warn("dexscreener_chunk_failed", { error: lastError?.slice(0, 120) });
      }
    }
    const latencyMs = Date.now() - t0;
    const droppedNote =
      dropped.length > 0 ? ` dropped ${dropped.length}: ${dropped.slice(0, 3).join(" | ").slice(0, 200)}` : "";
    return {
      observations,
      statusCode: lastStatus,
      latencyMs,
      fetchedAt,
      error: lastError !== null && observations.length === 0 ? lastError : lastError !== null ? `${lastError}${droppedNote}` : droppedNote || null,
    };
  }

  async searchPairs(query: string, signal?: AbortSignal): Promise<FetchResult> {
    const fetchedAt = Date.now();
    const t0 = Date.now();
    if (query.trim() === "") {
      return { observations: [], statusCode: null, latencyMs: 0, fetchedAt, error: "empty query" };
    }
    const url = `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`;
    try {
      const { status, json, latencyMs } = await getJson(url, signal);
      const observedAt = Date.now();
      const parsed = parsePairs(json, "dexscreener:search", observedAt, latencyMs);
      const droppedNote =
        parsed.dropped.length > 0 ? ` dropped ${parsed.dropped.length}` : "";
      return {
        observations: parsed.observations,
        statusCode: status,
        latencyMs: Date.now() - t0,
        fetchedAt,
        error: droppedNote || null,
      };
    } catch (err) {
      return {
        observations: [],
        statusCode: err instanceof RetryableError ? err.status : null,
        latencyMs: Date.now() - t0,
        fetchedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const __testOnly = { normalizePair, parsePairs, numToDecimal, strDecimal, cleanMintList, chunkMints, stableStringify };
