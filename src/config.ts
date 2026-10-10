/**
 * Validated application configuration (§5.5 defaults: unvalidated starting
 * points, not recommendations). All knobs are validated at startup with zod;
 * invalid config throws before anything runs. Execution mode is NOT here —
 * it is hardcoded in safety/executionMode.ts (§2.1.1).
 */
import { z } from "zod";

const positiveInt = z.number().int().positive();
const fraction = z.number().min(0).max(1);

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
  appDbPath: z.string().min(1).default("./data/solsnipe.sqlite"),
  // Local service.
  bindHost: z.string().min(1).default("127.0.0.1"),
  port: positiveInt.default(3000),
});

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
    appDbPath: env["SOLSNIPE_APP_DB_PATH"],
    bindHost: env["SOLSNIPE_BIND_HOST"],
    port: env["SOLSNIPE_PORT"] !== undefined ? Number(env["SOLSNIPE_PORT"]) : undefined,
  });
}
