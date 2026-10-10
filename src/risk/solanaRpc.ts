/**
 * Read-only Solana JSON-RPC client (§12). Plain JSON-RPC over the allowlisted
 * `allowedFetch` — no SDK, no signing, no wallet code (§2.1.2). Only methods
 * that READ account state are exposed; there is no send/submit path in this
 * module by construction (no method parameter for transactions exists).
 */
import { z } from "zod";
import { allowedFetch } from "../net/httpClient.js";
import { logger } from "../util/logger.js";

const RpcValueSchema = z.object({
  data: z.unknown(),
  executable: z.boolean(),
  lamports: z.number(),
  owner: z.string(),
  space: z.number().optional(),
  rentEpoch: z.number().optional(),
});

const RpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.unknown().optional(),
  result: z.object({
    context: z.object({ slot: z.number(), apiVersion: z.string().optional() }).passthrough(),
    value: RpcValueSchema.nullable(),
  }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export interface MintInfo {
  /** null = authority revoked (fixed supply); string = live authority. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: string;
  /** Owning program id: classic Token vs Token-2022 vs unknown. */
  programId: string;
  fetchedAt: number;
  slot: number;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdk8jVTt9Y4nZq1W6g1x2Q1d9U8J";

function parseMintData(programId: string, data: unknown): Omit<MintInfo, "programId" | "fetchedAt" | "slot"> | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { parsed?: { info?: Record<string, unknown>; type?: string }; program?: string };
  if (d.parsed === undefined || d.parsed.type !== "mint" || typeof d.parsed.info !== "object" || d.parsed.info === null) {
    return null;
  }
  void programId;
  const info = d.parsed.info;
  const optKey = (v: unknown): string | null =>
    v === null || v === undefined ? null : typeof v === "string" ? v : null;
  const decimals = info["decimals"];
  const supply = info["supply"];
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || typeof supply !== "string") {
    return null;
  }
  return {
    mintAuthority: optKey(info["mintAuthority"]),
    freezeAuthority: optKey(info["freezeAuthority"]),
    decimals,
    supply,
  };
}

/** Read-only getAccountInfo with jsonParsed encoding. Returns null on any failure (caller maps to UNKNOWN). */
export async function fetchMintInfo(
  mint: string,
  rpcUrl = "https://api.mainnet-beta.solana.com",
  signal?: AbortSignal,
): Promise<MintInfo | null> {
  const url = rpcUrl;
  try {
    const res = await allowedFetch(
      url,
      signal === undefined
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getAccountInfo",
              params: [mint, { encoding: "jsonParsed" }],
            }),
            timeoutMs: 15_000,
          }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getAccountInfo",
              params: [mint, { encoding: "jsonParsed" }],
            }),
            timeoutMs: 15_000,
            signal,
          },
    );
    if (res.status < 200 || res.status >= 300) {
      logger.warn("rpc_mint_http", { status: res.status });
      return null;
    }
    const parsed = RpcResponseSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.result === undefined || parsed.data.result.value === null) {
      return null;
    }
    const { value, context } = parsed.data.result;
    const mintData = parseMintData(value.owner, value.data);
    if (mintData === null) return null;
    return { ...mintData, programId: value.owner, fetchedAt: Date.now(), slot: context.slot };
  } catch (err) {
    logger.warn("rpc_mint_failed", { error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120) });
    return null;
  }
}

export const TOKEN_PROGRAM_ID = TOKEN_PROGRAM;
export const TOKEN_2022_PROGRAM_ID = TOKEN_2022_PROGRAM;

/** Transfer-restricting Token-2022 extensions (§12.1 policy: presence = FAIL). */
export const RESTRICTIVE_EXTENSIONS: readonly string[] = [
  "transferFee",
  "transferHook",
  "permanentDelegate",
  "nonTransferable",
  "defaultAccountState",
  "confidentialTransfers",
  "memoRequired",
] as const;

export function isClassicTokenProgram(programId: string): boolean {
  return programId === TOKEN_PROGRAM;
}

export function isToken2022Program(programId: string): boolean {
  return programId === TOKEN_2022_PROGRAM;
}
