/**
 * Detached market-snapshot recorder main loop (§9.3).
 *
 * - Anchored setTimeout schedule: due_n = t0 + n*interval, never setInterval.
 *   At most one in-flight poll; overruns fire next immediately (no catch-up).
 * - Gap rule: drift >= 1.5*interval → explicit gap row [firstMissedDue, now).
 * - Poll deadline aborts slow fetches so one bad poll can't stall the loop.
 * - One transaction per poll (store.writePoll); SIGTERM/SIGINT flush a final
 *   SHUTDOWN heartbeat before exit. Restart writes a RESTART gap if owed.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DexscreenerProvider, RECORDER_VERSION, type RetryableError } from "../providers/dexscreener.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../db/snapshots.js";
import { logger } from "../util/logger.js";
import { SnapshotStore } from "./store.js";
import { loadWatchlist, type Watchlist } from "./watchlist.js";
import { resolve } from "node:path";

export interface RecorderOptions {
  dbPath: string;
  watchlistPath: string;
  intervalMs: number;
  maxMints: number;
}

function parseArgs(argv: string[]): RecorderOptions {
  const cfg = loadConfig();
  const opts: RecorderOptions = {
    dbPath: resolve(cfg.recorderDbPath),
    watchlistPath: resolve(cfg.watchlistPath),
    intervalMs: cfg.recorderIntervalMs,
    maxMints: cfg.recorderMaxMints,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next !== undefined) { opts.dbPath = resolve(next); i++; }
    else if (arg === "--watchlist" && next !== undefined) { opts.watchlistPath = resolve(next); i++; }
    else if (arg === "--interval-ms" && next !== undefined) { opts.intervalMs = Number(next); i++; }
    else if (arg === "--max-mints" && next !== undefined) { opts.maxMints = Number(next); i++; }
  }
  if (!Number.isInteger(opts.intervalMs) || opts.intervalMs < 5_000) {
    throw new Error(`--interval-ms must be an integer >= 5000 (got ${String(opts.intervalMs)})`);
  }
  if (!Number.isInteger(opts.maxMints) || opts.maxMints < 1) {
    throw new Error(`--max-mints must be a positive integer`);
  }
  return opts;
}

function classifyGap(error: string | null, status: number | null): string {
  if (status === 429) return "PROVIDER_429";
  if (status !== null && status >= 500) return "PROVIDER_5XX";
  if (error !== null && /abort|timeout/i.test(error)) return "FETCH_TIMEOUT";
  if (status === null && error !== null) return "NETWORK_ERROR";
  return "UNKNOWN";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const startupId = randomBytes(8).toString("hex");
  logger.info("recorder_startup", {
    startupId, dbPath: opts.dbPath, watchlistPath: opts.watchlistPath,
    intervalMs: opts.intervalMs, version: RECORDER_VERSION,
  });

  const db: DatabaseSync = openDatabase(opts.dbPath, SNAPSHOT_MIGRATIONS);
  const store = new SnapshotStore(db);
  const provider = new DexscreenerProvider();
  const startupWall = Date.now();
  const startupMono = process.hrtime.bigint();

  const wroteRestartGap = store.recordRestartGap(startupWall, opts.intervalMs);
  if (wroteRestartGap) logger.warn("recorder_restart_gap", { startupWall });

  let watchlist: Watchlist = loadWatchlist(opts.watchlistPath);
  if (watchlist.mints.length > opts.maxMints) {
    throw new Error(`watchlist has ${watchlist.mints.length} mints, max is ${opts.maxMints}`);
  }
  logger.info("recorder_watchlist", { mints: watchlist.mints.length, hash: watchlist.hash });

  let seq = 0;
  let consecutiveErrors = 0;
  let shuttingDown = false;
  let timer: NodeJS.Timeout | null = null;
  let aborter: AbortController | null = null;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.warn("recorder_forced_shutdown", { signal });
      try { db.close(); } catch { /* already closed */ }
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    shuttingDown = true;
    logger.info("recorder_shutdown", { signal });
    if (timer !== null) clearTimeout(timer);
    aborter?.abort();
    // Bounded grace: the in-flight poll has the poll deadline to finish.
    setTimeout(() => {
      try {
        store.writePoll(
          { pollId: seq, scheduledDueMs: startupWall, actualStartMs: Date.now(), driftMs: 0, durationMs: 0, slow: false },
          { provider: "dexscreener", endpoint: "shutdown", statusCode: null, latencyMs: 0, error: null, rawBody: null, observations: [], dropped: 0 },
          watchlist.mints.length,
          { startupId, intervalMs: opts.intervalMs, pairsSeen: 0, consecutiveErrors, watchlistHash: watchlist.hash, recorderVersion: RECORDER_VERSION, status: "SHUTDOWN", errorDetail: `clean shutdown via ${signal}` },
        );
        db.close();
      } catch (err) {
        logger.error("recorder_shutdown_write_failed", { error: String(err).slice(0, 200) });
      }
      process.exit(0);
    }, 12_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const runPoll = async (dueWall: number, dueMono: bigint): Promise<void> => {
    const pollId = ++seq;
    const actualStartMs = Date.now();
    const driftMs = actualStartMs - dueWall;
    const intervalMs = opts.intervalMs;

    // Gap detection: drift >= 1.5*I means ≥1 full boundary was missed.
    if (driftMs >= Math.floor(intervalMs * 1.5)) {
      const missed = Math.max(1, Math.floor(driftMs / intervalMs));
      const monoNow = process.hrtime.bigint();
      const monoGapMs = Number((monoNow - dueMono) / 1_000_000n);
      const wallGapMs = actualStartMs - (dueWall - (missed - 1) * intervalMs);
      store.recordGap({
        gapStart: dueWall - (missed - 1) * intervalMs,
        gapEnd: actualStartMs,
        expectedPolls: missed,
        reason: consecutiveErrors > 0 ? classifyGap(null, null) : "EVENT_LOOP_LAG",
        detail: `anchored drift ${driftMs}ms over ${missed} missed boundaries`,
        kind: "FULL",
        lastPollId: pollId - 1 > 0 ? pollId - 1 : null,
        firstPollIdAfter: pollId,
        monoGapMs,
        wallGapMs,
      });
      logger.warn("recorder_gap", { pollId, missed, driftMs });
    }

    aborter = new AbortController();
    const pollTimeout = setTimeout(() => aborter?.abort(), Math.min(intervalMs - 1_000, 30_000));
    const fetchStart = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    const rawBody: string | null = null; // audit trail is per-observation rawHash; poll bodies deferred to M6
    let observations: import("../providers/types.js").NormalizedObservation[] = [];
    const dropped = 0;
    try {
      const result = await provider.fetchPairsByMints(watchlist.mints, aborter.signal);
      status = result.statusCode;
      error = result.error;
      observations = result.observations;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if ((err as Partial<RetryableError>).status !== undefined) {
        status = (err as unknown as RetryableError).status;
      }
    } finally {
      clearTimeout(pollTimeout);
    }
    const durationMs = Date.now() - fetchStart;
    const slow = durationMs > intervalMs;

    const ok = status !== null && status >= 200 && status < 300;
    consecutiveErrors = ok ? 0 : consecutiveErrors + 1;
    const pollStatus = !ok ? "ERROR" : slow || driftMs > intervalMs / 2 ? "DEGRADED" : "OK";

    try {
      store.writePoll(
        { pollId, scheduledDueMs: dueWall, actualStartMs, driftMs, durationMs, slow },
        { provider: "dexscreener", endpoint: "tokens", statusCode: status, latencyMs: durationMs, error, rawBody, observations, dropped },
        watchlist.mints.length,
        { startupId, intervalMs, pairsSeen: observations.length, consecutiveErrors, watchlistHash: watchlist.hash, recorderVersion: RECORDER_VERSION, status: pollStatus, errorDetail: error },
      );
    } catch (err) {
      logger.error("recorder_write_failed", { pollId, error: String(err).slice(0, 200) });
      consecutiveErrors += 1;
    }

    if ((pollId & 255) === 0) {
      const health = store.getHealth();
      logger.info("recorder_health", { pollId, ...health });
    }
  };

  // Anchored schedule: due_n = t0 + n*I. Overruns fire next immediately.
  let n = 0;
  const scheduleNext = (): void => {
    if (shuttingDown) return;
    n += 1;
    const dueWall = startupWall + n * opts.intervalMs;
    const dueMono = startupMono + BigInt(n) * BigInt(opts.intervalMs) * 1_000_000n;
    const delay = Math.max(0, dueWall - Date.now());
    timer = setTimeout(() => {
      void runPoll(dueWall, dueMono).finally(scheduleNext);
    }, delay);
  };
  // Startup heartbeat (poll 0): proves the process is alive before first fetch.
  store.writePoll(
    { pollId: 0, scheduledDueMs: startupWall, actualStartMs: startupWall, driftMs: 0, durationMs: 0, slow: false },
    { provider: "dexscreener", endpoint: "startup", statusCode: null, latencyMs: 0, error: null, rawBody: null, observations: [], dropped: 0 },
    watchlist.mints.length,
    { startupId, intervalMs: opts.intervalMs, pairsSeen: 0, consecutiveErrors: 0, watchlistHash: watchlist.hash, recorderVersion: RECORDER_VERSION, status: "OK", errorDetail: "startup" },
  );
  scheduleNext();
}

main().catch((err) => {
  logger.error("recorder_fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
