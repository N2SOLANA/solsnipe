/**
 * Durable snapshot persistence. One transaction contains every observation,
 * fetch event, and heartbeat for a poll: crash recovery never leaves a half-
 * written poll. Duplicate delivery is harmless via UNIQUE(poll_id,mint,pair).
 */
import type { DatabaseSync } from "node:sqlite";
import type { NormalizedObservation } from "../providers/types.js";
import { redactSecrets } from "../util/logger.js";

export interface PollTiming {
  pollId: number;
  scheduledDueMs: number;
  actualStartMs: number;
  driftMs: number;
  durationMs: number;
  slow: boolean;
}

export interface PollResult {
  provider: string;
  endpoint: string;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  rawBody: string | null;
  observations: NormalizedObservation[];
  dropped: number;
}

export interface HeartbeatMeta {
  startupId: string;
  intervalMs: number;
  pairsSeen: number;
  consecutiveErrors: number;
  watchlistHash: string;
  recorderVersion: string;
  status: "OK" | "DEGRADED" | "ERROR" | "SHUTDOWN";
  errorDetail: string | null;
}

function dbSizeBytes(db: DatabaseSync): number {
  const pageCount = db.prepare("PRAGMA page_count").get() as { page_count?: number };
  const pageSize = db.prepare("PRAGMA page_size").get() as { page_size?: number };
  return (pageCount.page_count ?? 0) * (pageSize.page_size ?? 0);
}

export class SnapshotStore {
  constructor(readonly db: DatabaseSync) {}

  getLastHeartbeat(): { ts: number; status: string; pollId: number } | null {
    const row = this.db.prepare(
      "SELECT ts, status, poll_id AS pollId FROM heartbeats ORDER BY ts DESC, id DESC LIMIT 1",
    ).get() as { ts: number; status: string; pollId: number } | undefined;
    return row ?? null;
  }

  getLastCleanShutdown(): { ts: number; pollId: number } | null {
    const row = this.db.prepare(
      "SELECT ts, poll_id AS pollId FROM heartbeats WHERE status='SHUTDOWN' ORDER BY ts DESC, id DESC LIMIT 1",
    ).get() as { ts: number; pollId: number } | undefined;
    return row ?? null;
  }

  /** Write a restart gap only when the prior heartbeat is stale enough.
   * Idempotent per window: a second call for the same last-write point is a
   * no-op (a gap row with that gap_start already exists). */
  recordRestartGap(nowMs: number, intervalMs: number): boolean {
    const last = this.getLastHeartbeat();
    if (last === null || nowMs - last.ts < Math.floor(intervalMs * 1.5)) return false;
    const covered = this.db.prepare(
      "SELECT id FROM gaps WHERE gap_start = ? AND kind IN ('RESTART','SHUTDOWN') LIMIT 1",
    ).get(last.ts);
    if (covered !== undefined) return false;
    const clean = this.getLastCleanShutdown();
    const cleanStop = clean !== null && clean.ts <= last.ts;
    const reason = cleanStop ? "SHUTDOWN_CLEAN" : "PROCESS_RESTART";
    const kind = cleanStop ? "SHUTDOWN" : "RESTART";
    const start = last.ts;
    const expected = Math.max(1, Math.floor((nowMs - start) / intervalMs));
    // Columns: gap_start, gap_end, expected_polls, actual_polls(=0),
    // reason, detail, kind, last_poll_id, first_poll_id_after(NULL),
    // mono_gap_ms(NULL — wall/monotonic delta unknown across restart),
    // wall_gap_ms, created_at_ms → 10 binds.
    this.db.prepare(`
      INSERT INTO gaps
        (gap_start, gap_end, expected_polls, actual_polls, reason, detail,
         kind, last_poll_id, first_poll_id_after, mono_gap_ms, wall_gap_ms, created_at_ms)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      start, nowMs, expected, reason,
      `startup gap; previous heartbeat ${last.status}`,
      kind, last.pollId, nowMs - start, nowMs,
    );
    return true;
  }

  /** Explicit gap for a missed anchored schedule window. */
  recordGap(args: {
    gapStart: number;
    gapEnd: number;
    expectedPolls: number;
    reason: string;
    detail: string;
    kind?: "FULL" | "RESTART" | "SHUTDOWN";
    lastPollId?: number | null;
    firstPollIdAfter?: number | null;
    monoGapMs?: number | null;
    wallGapMs?: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO gaps
        (gap_start, gap_end, expected_polls, actual_polls, reason, detail,
         kind, last_poll_id, first_poll_id_after, mono_gap_ms, wall_gap_ms, created_at_ms)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.gapStart,
      args.gapEnd,
      Math.max(1, Math.floor(args.expectedPolls)),
      redactSecrets(args.reason).slice(0, 64),
      redactSecrets(args.detail).slice(0, 500),
      args.kind ?? "FULL",
      args.lastPollId ?? null,
      args.firstPollIdAfter ?? null,
      args.monoGapMs ?? null,
      args.wallGapMs ?? null,
      Date.now(),
    );
  }

  /** Atomic poll write. INSERT OR IGNORE makes duplicate poll replay idempotent. */
  writePoll(
    timing: PollTiming,
    result: PollResult,
    mintsWatched: number,
    heartbeat: HeartbeatMeta,
  ): { inserted: number; obsTotal: number } {
    this.db.exec("BEGIN");
    try {
      const insertObs = this.db.prepare(`
        INSERT OR IGNORE INTO observations
          (mint, pair_address, dex_id, chain_id, quote_mint, price_usd,
           price_native, liquidity_usd, liquidity_base, liquidity_quote,
           volume_h24, volume_h6, volume_h1, volume_m5, txns_h24_buys,
           txns_h24_sells, price_change_h24, market_cap, fdv, pair_created_at,
           observed_at, source, latency_ms, raw_hash, validation_notes, poll_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let inserted = 0;
      for (const o of result.observations) {
        const r = insertObs.run(
          o.mint, o.pairAddress, o.dexId, o.chainId, o.quoteMint,
          o.priceUsd, o.priceNative, o.liquidityUsd, o.liquidityBase,
          o.liquidityQuote, o.volumeH24, o.volumeH6, o.volumeH1, o.volumeM5,
          o.txnsH24Buys, o.txnsH24Sells, o.priceChangeH24, o.marketCap, o.fdv,
          o.pairCreatedAt, o.observedAt, o.source, Math.floor(o.latencyMs),
          o.rawHash, JSON.stringify(o.validationNotes), timing.pollId,
        ) as { changes?: number };
        inserted += r.changes ?? 0;
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO fetch_events
          (poll_id, ts, provider, endpoint, status_code, latency_ms, obs_count,
           error, scheduled_due_ms, drift_ms, duration_ms, slow, attempt,
           watchlist_hash, raw_body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        timing.pollId, Date.now(), result.provider, redactSecrets(result.endpoint).slice(0, 256),
        result.statusCode, Math.floor(result.latencyMs), inserted,
        result.error === null ? null : redactSecrets(result.error).slice(0, 500),
        timing.scheduledDueMs, timing.driftMs, timing.durationMs, heartbeat.status === "DEGRADED" ? 1 : 0,
        heartbeat.watchlistHash, result.rawBody === null ? null : redactSecrets(result.rawBody).slice(0, 20_000),
      );
      const obsTotalRow = this.db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
      this.db.prepare(`
        INSERT OR IGNORE INTO heartbeats
          (ts, poll_id, mints_watched, obs_written, startup_id, interval_ms,
           drift_ms, duration_ms, fetch_status, fetch_latency_ms, pairs_seen,
           errors, status, watchlist_hash, recorder_version, db_size_bytes,
           obs_total, error_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Date.now(), timing.pollId, mintsWatched, inserted, heartbeat.startupId,
        heartbeat.intervalMs, timing.driftMs, timing.durationMs, result.statusCode,
        Math.floor(result.latencyMs), heartbeat.pairsSeen, heartbeat.consecutiveErrors,
        heartbeat.status, heartbeat.watchlistHash, heartbeat.recorderVersion,
        dbSizeBytes(this.db), obsTotalRow.n,
        heartbeat.errorDetail === null ? null : redactSecrets(heartbeat.errorDetail).slice(0, 500),
      );
      this.db.exec("COMMIT");
      return { inserted, obsTotal: obsTotalRow.n };
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw err;
    }
  }

  getHealth(): {
    observations: number;
    heartbeats: number;
    gaps: number;
    lastWrite: number | null;
  } {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      observations: one("SELECT COUNT(*) AS n FROM observations"),
      heartbeats: one("SELECT COUNT(*) AS n FROM heartbeats"),
      gaps: one("SELECT COUNT(*) AS n FROM gaps"),
      lastWrite: (this.db.prepare("SELECT MAX(ts) AS ts FROM heartbeats").get() as { ts: number | null }).ts,
    };
  }
}
