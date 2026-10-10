/**
 * Validated application configuration (§5.5 defaults: unvalidated starting
 * points, not recommendations). All knobs are validated at startup with zod;
 * invalid config throws before anything runs. Execution mode is NOT here —
 * it is hardcoded in safety/executionMode.ts (§2.1.1).
 */
import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const positiveInt = z.number().int().positive();
const fraction = z.number().min(0).max(1);

/** Repo root: the directory containing package.json (one up from src/). */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
}

/**
 * Resolve a DB path against the repo root and confine it to <root>/data
 * (audit M2/M4). `..` escapes and absolute outside-data paths are rejected —
 * a detached process launched from another cwd must open the SAME file,
 * never fork a second DB or write outside the repo.
 */
function confinedDbPath(value: string | undefined, fallback: string, label: string): string {
  const raw = value ?? fallback;
  const root = repoRoot();
  const abs = isAbsolute(raw) ? raw : resolve(root, raw);
  const rel = relative(resolve(root, "data"), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside <repo>/data (got "${raw}")`);
  }
  return abs;
}

const LoopbackHost = z
  .string()
  .min(1)
  .refine((h) => h === "127.0.0.1" || h === "localhost" || h === "::1", {
    message: "bindHost must be loopback (127.0.0.1, localhost, ::1); non-local bind needs review",
  })
  .default("127.0.0.1");

export const ConfigSchema = z.object({
  // Money (lamports as bigint-compatible ints; validated as safe ints here,
  // converted to bigint at use sites).
  startingCapitalLamports: positiveInt.default(10_000_000_000), // 10 SOL
  // Risk limits (§5.5).
  maxPositionFraction: fraction.default(0.04),
  maxExposurePerTokenFraction: fraction.default(0.04),
  maxTotalExposureFraction: fraction.default(0.3),
  maxOpenPositions: positiveInt.default(6),
  maxDailyLossFraction: fraction.default(0.08),
  maxDrawdownFraction: fraction.default(0.2),
  maxEntryCostFraction: fraction.default(0.04),
  maxExitImpactFraction: fraction.default(0.06),
  minPoolLiquidityUsd: z.number().positive().default(40_000),
  maxPositionShareOfLiquidity: fraction.default(0.005),
  // Freshness (ms).
  maxScannerDataAgeMs: positiveInt.default(90_000),
  maxRiskDataAgeMs: positiveInt.default(30_000),
  maxExecutionDataAgeMs: positiveInt.default(10_000),
  minPairAgeMs: positiveInt.default(30 * 60_000), // 30 min (§5.5; why: filters fresh-launch chaos)
  cooldownAfterFailuresMs: positiveInt.default(15 * 60_000),
  consecutiveFailuresForCooldown: positiveInt.default(3),
  // Recorder.
  recorderIntervalMs: positiveInt.default(15_000),
  recorderDbPath: z.string().min(1).default("./data/snapshots.sqlite"),
  watchlistPath: z.string().min(1).default("./config/watchlist.json"),
  snapshotRetentionDays: z.number().int().min(1).default(30),
  recorderMaxMints: positiveInt.default(30),
  appDbPath: z.string().min(1).default("./data/solsnipe.sqlite"),
  // Local service.
  bindHost: LoopbackHost,
  port: positiveInt.default(3000),
});

/** Resolved absolute paths (repo-root-anchored, data-confined). */
export interface ResolvedPaths {
  recorderDbPath: string;
  appDbPath: string;
  watchlistPath: string;
}

export function resolvePaths(cfg: AppConfig): ResolvedPaths {
  return {
    recorderDbPath: confinedDbPath(cfg.recorderDbPath, "./data/snapshots.sqlite", "recorderDbPath"),
    appDbPath: confinedDbPath(cfg.appDbPath, "./data/solsnipe.sqlite", "appDbPath"),
    watchlistPath: isAbsolute(cfg.watchlistPath)
      ? cfg.watchlistPath
      : resolve(repoRoot(), cfg.watchlistPath),
  };
}

export type AppConfig = z.infer<typeof ConfigSchema>;

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN; // NaN fails zod validation loudly
}

/** Load config: env overrides (SOLSNIPE_* names only) over schema defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    recorderIntervalMs: envNumber("SOLSNIPE_RECORDER_INTERVAL_MS"),
    recorderDbPath: env["SOLSNIPE_RECORDER_DB_PATH"],
    watchlistPath: env["SOLSNIPE_WATCHLIST_PATH"],
    snapshotRetentionDays: envNumber("SOLSNIPE_SNAPSHOT_RETENTION_DAYS"),
    recorderMaxMints: envNumber("SOLSNIPE_RECORDER_MAX_MINTS"),
    appDbPath: env["SOLSNIPE_APP_DB_PATH"],
    bindHost: env["SOLSNIPE_BIND_HOST"],
    port: env["SOLSNIPE_PORT"] !== undefined ? Number(env["SOLSNIPE_PORT"]) : undefined,
  });
}
