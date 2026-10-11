/**
 * Dashboard view-models — M7 data layer (§19.2 panels A–G).
 *
 * Pure builders over read-only snapshot-DB rows: no network, no writes, no
 * float money math (decimal strings pass through untouched; ages are integer
 * ms arithmetic). Portfolio (D) and performance (E) panels are honest EMPTY
 * states — the paper-trading engine (Milestone 4) is not built yet, so there
 * are no positions, balances, or P&L to show, and we say so instead of zeros.
 */
import type { DatabaseSync } from "node:sqlite";
import { Decimal } from "decimal.js";
import { EXECUTION_MODE } from "../safety/executionMode.js";
import type { SelfCheckResult } from "../safety/selfCheck.js";
import { scanObservation } from "../scanner/scanner.js";
import { runRiskChecks } from "../risk/checks.js";
import type { NormalizedObservation } from "../providers/types.js";

/** §5.5 default: scanner data older than this is STALE (overridable via config). */
export const DEFAULT_STALE_AFTER_MS = 90_000;

export const SCANNER_LIMIT_DEFAULT = 500;
export const ACTIVITY_LIMIT_DEFAULT = 20;

/** Latest observation per pair (panel A). Decimal fields stay strings. */
export interface ScannerRow {
  mint: string;
  pairAddress: string;
  dexId: string;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volumeH24: string | null;
  priceChangeH24: string | null;
  pairCreatedAt: number | null;
  observedAt: number;
  source: string;
}

export type Freshness = "FRESH" | "STALE";

export interface ScannerItem extends ScannerRow {
  ageMs: number;
  freshness: Freshness;
  pairAgeMs: number | null;
}

export interface ScannerView {
  panel: "scanner";
  generatedAt: number;
  staleAfterMs: number;
  sources: string;
  rows: ScannerItem[];
  totalPairs: number;
  truncated: boolean;
  empty: boolean;
  reason: string | null;
}

export interface FetchEventRow {
  pollId: number;
  ts: number;
  provider: string;
  endpoint: string;
  statusCode: number | null;
  latencyMs: number;
  obsCount: number;
  error: string | null;
}

export interface HeartbeatRow {
  ts: number;
  pollId: number;
  mintsWatched: number;
  obsWritten: number;
  intervalMs: number;
  status: string;
  fetchStatus: number | null;
  fetchLatencyMs: number | null;
  errors: number | null;
  errorDetail: string | null;
}

export interface GapRow {
  gapStart: number;
  gapEnd: number;
  expectedPolls: number;
  actualPolls: number;
  reason: string;
  detail: string | null;
  kind: string;
}

export interface ProviderStatus {
  provider: string;
  endpoint: string;
  lastTs: number;
  statusCode: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

export interface RecorderCounts {
  observations: number;
  heartbeats: number;
  fetchEvents: number;
  gaps: number;
}

export interface HealthView {
  panel: "health";
  generatedAt: number;
  staleAfterMs: number;
  executionMode: typeof EXECUTION_MODE;
  selfCheck: SelfCheckResult;
  lastUpdateTs: number | null;
  lastObservationTs: number | null;
  dataStale: boolean;
  recorderStatus: string;
  recorderDetail: string;
  providers: ProviderStatus[];
  gaps: GapRow[];
  counts: RecorderCounts;
}

export interface ActivityView {
  panel: "activity";
  generatedAt: number;
  fetchEvents: FetchEventRow[];
  heartbeats: HeartbeatRow[];
  note: string;
}

export interface PortfolioPosition {
  token: string;
  qtyBaseUnits: string;
  costBasisLamports: string;
  markPrice: string | null;
  marketValueLamports: string | null;
  unrealizedPnlLamports: string | null;
}

export interface PortfolioPanel {
  panel: "portfolio";
  empty: boolean;
  reason: string | null;
  startLamports: string | null;
  cashLamports: string | null;
  realizedPnlLamports: string | null;
  equityLamports: string | null;
  openPositions: PortfolioPosition[];
  emergencyStop: boolean;
}

export interface PerformancePanel {
  panel: "performance";
  empty: boolean;
  reason: string | null;
  trades: number;
  netPnlLamports: string | null;
  verdict: string | null;
  windowStart: number | null;
  windowEnd: number | null;
}

export interface MarketHistoryPoint {
  mint: string;
  pairAddress: string;
  observedAt: number;
  priceUsd: string;
}

export interface CandidateView {
  mint: string;
  pairAddress: string;
  dexId: string;
  outcome: string;
  explanation: string;
  rules: { ruleId: string; verdict: string; observedValue: string | null; threshold: string }[];
  risk: { checkId: string; status: string }[];
}

export interface DashboardView {
  generatedAt: number;
  scanner: ScannerView;
  candidates: CandidateView[];
  health: HealthView;
  activity: ActivityView;
  portfolio: PortfolioPanel;
  performance: PerformancePanel;
  /** Recorded price history only — no interpolation or fabricated points. */
  marketHistory: MarketHistoryPoint[];
}

export interface BuildOptions {
  nowMs: number;
  staleAfterMs: number;
  selfCheck: SelfCheckResult;
  activityLimit?: number;
  scannerLimit?: number;
  /** Paper state from the app DB (absent = honest empty portfolio panel). */
  paper?: PaperState | undefined;
  /** Replay summary computed over the snapshot window (absent = honest empty). */
  replay?: ReplaySummary | undefined;
}

// ---------------------------------------------------------------------------
// Read-only queries (SELECT only — never INSERT/UPDATE/DELETE here).
// ---------------------------------------------------------------------------

const SCANNER_SQL = `
  SELECT o.mint AS mint, o.pair_address AS pairAddress, o.dex_id AS dexId,
         o.price_usd AS priceUsd, o.liquidity_usd AS liquidityUsd,
         o.volume_h24 AS volumeH24, o.price_change_h24 AS priceChangeH24,
         o.pair_created_at AS pairCreatedAt, o.observed_at AS observedAt,
         o.source AS source
  FROM observations o
  JOIN (
    SELECT pair_address AS pa, MAX(observed_at) AS m
    FROM observations GROUP BY pair_address
  ) latest ON latest.pa = o.pair_address AND latest.m = o.observed_at
  ORDER BY o.observed_at DESC, o.mint ASC
  LIMIT ?
`;

export function readScannerRows(
  db: DatabaseSync,
  limit: number = SCANNER_LIMIT_DEFAULT,
): ScannerRow[] {
  return db.prepare(SCANNER_SQL).all(limit) as unknown as ScannerRow[];
}

export function countPairs(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(DISTINCT pair_address) AS n FROM observations")
    .get() as { n: number };
  return row.n;
}

export function readSources(db: DatabaseSync): string {
  const rows = db
    .prepare("SELECT DISTINCT source AS s FROM observations ORDER BY s")
    .all() as { s: string }[];
  return rows.length === 0 ? "none recorded" : rows.map((r) => r.s).join(", ");
}

export function readFetchEvents(
  db: DatabaseSync,
  limit: number = ACTIVITY_LIMIT_DEFAULT,
): FetchEventRow[] {
  return db
    .prepare(
      `SELECT poll_id AS pollId, ts, provider, endpoint,
              status_code AS statusCode, latency_ms AS latencyMs,
              obs_count AS obsCount, error
       FROM fetch_events ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(limit) as unknown as FetchEventRow[];
}

export function readHeartbeats(
  db: DatabaseSync,
  limit: number = ACTIVITY_LIMIT_DEFAULT,
): HeartbeatRow[] {
  return db
    .prepare(
      `SELECT ts, poll_id AS pollId, mints_watched AS mintsWatched,
              obs_written AS obsWritten, interval_ms AS intervalMs,
              status, fetch_status AS fetchStatus,
              fetch_latency_ms AS fetchLatencyMs, errors,
              error_detail AS errorDetail
       FROM heartbeats ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(limit) as unknown as HeartbeatRow[];
}

export function readGaps(db: DatabaseSync): GapRow[] {
  return db
    .prepare(
      `SELECT gap_start AS gapStart, gap_end AS gapEnd,
              expected_polls AS expectedPolls, actual_polls AS actualPolls,
              reason, detail, kind
       FROM gaps ORDER BY gap_start DESC LIMIT 200`,
    )
    .all() as unknown as GapRow[];
}

export function readCounts(db: DatabaseSync): RecorderCounts {
  const one = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;
  return {
    observations: one("SELECT COUNT(*) AS n FROM observations"),
    heartbeats: one("SELECT COUNT(*) AS n FROM heartbeats"),
    fetchEvents: one("SELECT COUNT(*) AS n FROM fetch_events"),
    gaps: one("SELECT COUNT(*) AS n FROM gaps"),
  };
}

export function readLastHeartbeat(db: DatabaseSync): HeartbeatRow | null {
  const rows = readHeartbeats(db, 1);
  return rows[0] ?? null;
}

export function readLastObservationTs(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT MAX(observed_at) AS m FROM observations").get() as {
    m: number | null;
  };
  return row.m;
}

export function readProviderStatuses(db: DatabaseSync): ProviderStatus[] {
  const providers = db
    .prepare("SELECT DISTINCT provider AS p FROM fetch_events ORDER BY p")
    .all() as { p: string }[];
  const out: ProviderStatus[] = [];
  for (const { p } of providers) {
    const row = db
      .prepare(
        `SELECT provider, endpoint, ts AS lastTs, status_code AS statusCode,
                latency_ms AS latencyMs, error
         FROM fetch_events WHERE provider = ? ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(p) as Omit<ProviderStatus, "ok">;
    out.push({
      ...row,
      ok: row.statusCode !== null && row.statusCode >= 200 && row.statusCode < 300 && row.error === null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure builders.
// ---------------------------------------------------------------------------

export function buildScannerView(
  rows: ScannerRow[],
  totalPairs: number,
  sources: string,
  nowMs: number,
  staleAfterMs: number,
): ScannerView {
  const items: ScannerItem[] = rows.map((r) => {
    const ageMs = nowMs - r.observedAt;
    const pairAgeMs =
      r.pairCreatedAt === null || r.pairCreatedAt > nowMs ? null : nowMs - r.pairCreatedAt;
    return {
      ...r,
      ageMs,
      freshness: ageMs <= staleAfterMs ? "FRESH" : "STALE",
      pairAgeMs,
    };
  });
  const empty = items.length === 0;
  return {
    panel: "scanner",
    generatedAt: nowMs,
    staleAfterMs,
    sources,
    rows: items,
    totalPairs,
    truncated: totalPairs > items.length,
    empty,
    reason: empty ? "No observations recorded yet — the recorder has not written any market data." : null,
  };
}

function describeRecorder(
  last: HeartbeatRow | null,
  nowMs: number,
): { status: string; detail: string } {
  if (last === null) {
    return {
      status: "UNKNOWN",
      detail: "No heartbeats recorded yet — the recorder may never have run.",
    };
  }
  const agoMs = nowMs - last.ts;
  const staleAfter = Math.max(last.intervalMs * 2, 30_000);
  if (agoMs > staleAfter) {
    return {
      status: "STALE",
      detail:
        `Last heartbeat ${new Date(last.ts).toISOString()} ` +
        `(poll ${last.pollId}, status ${last.status}) — the recorder may be stopped. ` +
        `Outage windows are listed as explicit gaps below; nothing was interpolated.`,
    };
  }
  const base =
    `Last heartbeat ${new Date(last.ts).toISOString()} ` +
    `(poll ${last.pollId}: watched ${last.mintsWatched}, wrote ${last.obsWritten}, ` +
    `fetch ${String(last.fetchStatus)}, errors ${String(last.errors ?? 0)})`;
  switch (last.status) {
    case "OK":
      return { status: "RUNNING", detail: `${base}.` };
    case "DEGRADED":
      return {
        status: "DEGRADED",
        detail: `${base}. Detail: ${last.errorDetail ?? "none recorded"}.`,
      };
    case "ERROR":
      return {
        status: "ERROR",
        detail: `${base}. Detail: ${last.errorDetail ?? "none recorded"}.`,
      };
    case "SHUTDOWN":
      return {
        status: "STOPPED",
        detail: `${base} — clean shutdown recorded. Restart with npm run recorder:start.`,
      };
    default:
      return { status: last.status, detail: `${base}.` };
  }
}

export function buildHealthView(
  lastHeartbeat: HeartbeatRow | null,
  lastObservationTs: number | null,
  providers: ProviderStatus[],
  gaps: GapRow[],
  counts: RecorderCounts,
  selfCheck: SelfCheckResult,
  nowMs: number,
  staleAfterMs: number,
): HealthView {
  const lastUpdateTs = lastHeartbeat?.ts ?? lastObservationTs ?? null;
  const { status, detail } = describeRecorder(lastHeartbeat, nowMs);
  return {
    panel: "health",
    generatedAt: nowMs,
    staleAfterMs,
    executionMode: EXECUTION_MODE,
    selfCheck,
    lastUpdateTs,
    lastObservationTs,
    dataStale: lastUpdateTs === null || nowMs - lastUpdateTs > staleAfterMs,
    recorderStatus: status,
    recorderDetail: detail,
    providers,
    gaps,
    counts,
  };
}

export function buildActivityView(
  fetchEvents: FetchEventRow[],
  heartbeats: HeartbeatRow[],
  nowMs: number,
): ActivityView {
  return {
    panel: "activity",
    generatedAt: nowMs,
    fetchEvents,
    heartbeats,
    note: "Most recent recorder rows, newest first. Gaps are explicit records — data is never interpolated or forward-filled.",
  };
}

export interface PaperState {
  startLamports: bigint;
  cashLamports: bigint;
  realizedPnlLamports: bigint;
  emergencyStop: boolean;
  positions: { token: string; qty: bigint; cost: bigint }[];
  /** Latest mark price per token (decimal string) for valuation. */
  marks: Record<string, string>;
}

export interface ReplaySummary {
  trades: number;
  netPnlLamports: string;
  verdict: string;
  windowStart: number;
  windowEnd: number;
}

/** Panel D: real paper state when present, honest empty when absent. */
export function buildPortfolioView(paper?: PaperState): PortfolioPanel {
  if (paper === undefined) {
    return {
      panel: "portfolio",
      empty: true,
      reason:
        "No paper-trading state recorded yet (no fills persisted to the app database). " +
        "This panel intentionally shows nothing instead of zeros.",
      startLamports: null,
      cashLamports: null,
      realizedPnlLamports: null,
      equityLamports: null,
      openPositions: [],
      emergencyStop: false,
    };
  }
  const openPositions: PortfolioPosition[] = paper.positions.map((p) => {
    const mark = paper.marks[p.token] ?? null;
    let marketValue: string | null = null;
    let unrealized: string | null = null;
    if (mark !== null) {
      try {
        const mv =
          BigInt(new Decimal(mark).mul(p.qty.toString()).toDecimalPlaces(0, Decimal.ROUND_FLOOR).toString());
        marketValue = mv.toString();
        unrealized = (mv - p.cost).toString();
      } catch {
        marketValue = null;
      }
    }
    return {
      token: p.token,
      qtyBaseUnits: p.qty.toString(),
      costBasisLamports: p.cost.toString(),
      markPrice: mark,
      marketValueLamports: marketValue,
      unrealizedPnlLamports: unrealized,
    };
  });
  const equity = openPositions.reduce(
    (acc, p) => acc + (p.marketValueLamports === null ? 0n : BigInt(p.marketValueLamports)),
    paper.cashLamports,
  );
  return {
    panel: "portfolio",
    empty: false,
    reason: null,
    startLamports: paper.startLamports.toString(),
    cashLamports: paper.cashLamports.toString(),
    realizedPnlLamports: paper.realizedPnlLamports.toString(),
    equityLamports: equity.toString(),
    openPositions,
    emergencyStop: paper.emergencyStop,
  };
}

/** Panel E: replay summary when computed, honest empty otherwise. */
export function buildPerformanceView(replay?: ReplaySummary): PerformancePanel {
  if (replay === undefined) {
    return {
      panel: "performance",
      empty: true,
      reason:
        "No replay computed yet. Performance appears here after a backtest run — " +
        "with no trades, any chart would be fabricated, so there is none.",
      trades: 0,
      netPnlLamports: null,
      verdict: null,
      windowStart: null,
      windowEnd: null,
    };
  }
  return {
    panel: "performance",
    empty: false,
    reason: null,
    trades: replay.trades,
    netPnlLamports: replay.netPnlLamports,
    verdict: replay.verdict,
    windowStart: replay.windowStart,
    windowEnd: replay.windowEnd,
  };
}

export function readMarketHistory(db: DatabaseSync, limit = 2000): MarketHistoryPoint[] {
  // Daily first-recorded USD price per pair, actual observations only.
  return db.prepare(
    `WITH ranked AS (
       SELECT mint, pair_address, observed_at, price_usd,
              ROW_NUMBER() OVER (
                PARTITION BY pair_address, date(observed_at / 1000, 'unixepoch')
                ORDER BY observed_at ASC
              ) AS rn
       FROM observations
       WHERE price_usd IS NOT NULL
     )
     SELECT mint, pair_address AS pairAddress, observed_at AS observedAt,
            price_usd AS priceUsd
     FROM ranked
     WHERE rn = 1
     ORDER BY observed_at ASC
     LIMIT ?`,
  ).all(limit) as unknown as MarketHistoryPoint[];
}

/** Candidate verdicts computed by the real scanner + risk pipeline over the
 * latest observation per pair (bounded to 60 pairs for snapshot cost). */
export function buildCandidates(db: DatabaseSync, nowMs: number): CandidateView[] {
  const latest = db.prepare(
    `SELECT o.* FROM observations o JOIN (
       SELECT pair_address AS pa, MAX(observed_at) AS m FROM observations GROUP BY pair_address
     ) l ON l.pa = o.pair_address AND l.m = o.observed_at
     ORDER BY o.observed_at DESC LIMIT 60`,
  ).all() as Record<string, unknown>[];
  const out: CandidateView[] = [];
  for (const r of latest) {
    const get = (k: string): string | null => (typeof r[k] === "string" ? (r[k] as string) : null);
    const getNum = (k: string): number | null => (typeof r[k] === "number" ? (r[k] as number) : null);
    const obs: NormalizedObservation = {
      mint: String(r["mint"] ?? ""),
      pairAddress: String(r["pair_address"] ?? ""),
      dexId: String(r["dex_id"] ?? ""),
      chainId: String(r["chain_id"] ?? ""),
      quoteMint: get("quote_mint"),
      priceUsd: get("price_usd"),
      priceNative: get("price_native"),
      liquidityUsd: get("liquidity_usd"),
      liquidityBase: get("liquidity_base"),
      liquidityQuote: get("liquidity_quote"),
      volumeH24: get("volume_h24"),
      volumeH6: get("volume_h6"),
      volumeH1: get("volume_h1"),
      volumeM5: get("volume_m5"),
      txnsH24Buys: getNum("txns_h24_buys"),
      txnsH24Sells: getNum("txns_h24_sells"),
      priceChangeH24: get("price_change_h24"),
      marketCap: get("market_cap"),
      fdv: get("fdv"),
      pairCreatedAt: getNum("pair_created_at"),
      observedAt: getNum("observed_at") ?? 0,
      source: String(r["source"] ?? ""),
      latencyMs: getNum("latency_ms") ?? 0,
      rawHash: String(r["raw_hash"] ?? ""),
      validationNotes: [],
    };
    if (obs.mint === "" || obs.pairAddress === "") continue;
    let scan;
    try {
      scan = scanObservation(obs, { nowMs });
    } catch {
      continue;
    }
    let riskStatuses: { checkId: string; status: string }[];
    try {
      riskStatuses = runRiskChecks(obs, nowMs).checks.map((c) => ({ checkId: c.checkId, status: c.status }));
    } catch {
      riskStatuses = [];
    }
    out.push({
      mint: obs.mint,
      pairAddress: obs.pairAddress,
      dexId: obs.dexId,
      outcome: scan.outcome,
      explanation: scan.explanation,
      rules: scan.rules.map((x) => ({ ruleId: x.ruleId, verdict: x.verdict, observedValue: x.observedValue, threshold: x.threshold })),
      risk: riskStatuses,
    });
  }
  return out;
}

export function buildDashboard(db: DatabaseSync, opts: BuildOptions): DashboardView {
  const scannerLimit = opts.scannerLimit ?? SCANNER_LIMIT_DEFAULT;
  const activityLimit = opts.activityLimit ?? ACTIVITY_LIMIT_DEFAULT;
  const rows = readScannerRows(db, scannerLimit);
  return {
    generatedAt: opts.nowMs,
    scanner: buildScannerView(rows, countPairs(db), readSources(db), opts.nowMs, opts.staleAfterMs),
    candidates: buildCandidates(db, opts.nowMs),
    health: buildHealthView(
      readLastHeartbeat(db),
      readLastObservationTs(db),
      readProviderStatuses(db),
      readGaps(db),
      readCounts(db),
      opts.selfCheck,
      opts.nowMs,
      opts.staleAfterMs,
    ),
    activity: buildActivityView(readFetchEvents(db, activityLimit), readHeartbeats(db, activityLimit), opts.nowMs),
    portfolio: buildPortfolioView(opts.paper),
    performance: buildPerformanceView(opts.replay),
    marketHistory: readMarketHistory(db),
  };
}

/** Honest empty dashboard for a missing/unreadable snapshot DB. */
export function emptyDashboard(
  reason: string,
  nowMs: number,
  selfCheck: SelfCheckResult,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): DashboardView {
  return {
    generatedAt: nowMs,
    scanner: {
      panel: "scanner",
      generatedAt: nowMs,
      staleAfterMs,
      sources: "none recorded",
      rows: [],
      totalPairs: 0,
      truncated: false,
      empty: true,
      reason,
    },
    health: {
      panel: "health",
      generatedAt: nowMs,
      staleAfterMs,
      executionMode: EXECUTION_MODE,
      selfCheck,
      lastUpdateTs: null,
      lastObservationTs: null,
      dataStale: true,
      recorderStatus: "UNKNOWN",
      recorderDetail: reason,
      providers: [],
      gaps: [],
      counts: { observations: 0, heartbeats: 0, fetchEvents: 0, gaps: 0 },
    },
    activity: {
      panel: "activity",
      generatedAt: nowMs,
      fetchEvents: [],
      heartbeats: [],
      note: reason,
    },
    candidates: [],
    portfolio: buildPortfolioView(),
    performance: buildPerformanceView(),
    marketHistory: [],
  };
}
