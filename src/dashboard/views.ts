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
import { EXECUTION_MODE } from "../safety/executionMode.js";
import type { SelfCheckResult } from "../safety/selfCheck.js";

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

export interface EmptyPanel {
  panel: "portfolio" | "performance";
  empty: true;
  reason: string;
}

export interface DashboardView {
  generatedAt: number;
  scanner: ScannerView;
  health: HealthView;
  activity: ActivityView;
  portfolio: EmptyPanel;
  performance: EmptyPanel;
}

export interface BuildOptions {
  nowMs: number;
  staleAfterMs: number;
  selfCheck: SelfCheckResult;
  activityLimit?: number;
  scannerLimit?: number;
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

/** Panel D: no engine, no positions — say so instead of zeros. */
export function buildPortfolioView(): EmptyPanel {
  return {
    panel: "portfolio",
    empty: true,
    reason:
      "Paper-trading engine not built yet (Milestone 4): no virtual positions, " +
      "balances, fills, or P&L exist. This panel intentionally shows nothing instead of zeros.",
  };
}

/** Panel E: no trades, no history — any chart here would be fabricated. */
export function buildPerformanceView(): EmptyPanel {
  return {
    panel: "performance",
    empty: true,
    reason:
      "Performance analytics need closed paper trades (Milestone 4) and replay " +
      "history (Milestone 6). With no trades yet, any chart here would be fabricated — so there is none.",
  };
}

export function buildDashboard(db: DatabaseSync, opts: BuildOptions): DashboardView {
  const scannerLimit = opts.scannerLimit ?? SCANNER_LIMIT_DEFAULT;
  const activityLimit = opts.activityLimit ?? ACTIVITY_LIMIT_DEFAULT;
  const rows = readScannerRows(db, scannerLimit);
  return {
    generatedAt: opts.nowMs,
    scanner: buildScannerView(rows, countPairs(db), readSources(db), opts.nowMs, opts.staleAfterMs),
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
    portfolio: buildPortfolioView(),
    performance: buildPerformanceView(),
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
    portfolio: buildPortfolioView(),
    performance: buildPerformanceView(),
  };
}
