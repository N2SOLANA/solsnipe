/**
 * Deterministic scanner rules, Milestone 3 (spec §10, §11).
 *
 * PAPER-ONLY: pure functions over NormalizedObservation. No trading, no
 * network, no clock reads — the caller passes `nowMs` (injectable clock, so
 * replay stays honest). All comparisons use decimal.js; no float money.
 *
 * Verdicts per rule: "pass" | "fail" | "unknown" (missing != zero: a null
 * field is "unknown", never evidence of safety).
 */
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { NormalizedObservation } from "../providers/types.js";

export const RuleVerdictSchema = z.enum(["pass", "fail", "unknown"]);
export type RuleVerdict = z.infer<typeof RuleVerdictSchema>;

export const RuleResultSchema = z.object({
  ruleId: z.string().min(1).max(64),
  verdict: RuleVerdictSchema,
  /** Echo of the observed value (decimal string or composite), null when unknown. */
  observedValue: z.string().max(240).nullable(),
  /** Human-readable threshold description, e.g. ">= 40000". */
  threshold: z.string().min(1).max(240),
  /** Provenance, copied from the observation (e.g. "dexscreener:tokens"). */
  source: z.string().min(1).max(64),
  observedAt: z.number().int().nonnegative(),
});
export type RuleResult = z.infer<typeof RuleResultSchema>;

export const ScannerOutcomeSchema = z.enum(["ACCEPT", "REJECT", "REVIEW"]);
export type ScannerOutcome = z.infer<typeof ScannerOutcomeSchema>;

const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "not a plain decimal string");

/**
 * Scanner thresholds. Defaults marked §5.5 come from the spec; the rest are
 * unvalidated starting points, NOT recommendations (spec §5.5).
 */
export const ScannerThresholdsSchema = z.object({
  /** §5.5: min pool liquidity, USD equivalent. */
  minLiquidityUsd: DecimalString.default("40000"),
  /** Min 24h volume, USD. Starting point, not a recommendation. */
  minVolumeH24Usd: DecimalString.default("10000"),
  /** Min 24h trade count (buys+sells). Starting point. */
  minTxnsH24: z.number().int().nonnegative().default(200),
  /** §5.5: min pair age before eligibility (filters fresh-launch chaos). */
  minPairAgeMs: z.number().int().positive().default(30 * 60_000),
  /** §5.5: max scanner data age. */
  maxDataAgeMs: z.number().int().positive().default(90_000),
  /** Max |24h price change| in percent before the spike guard trips. */
  maxAbsChangeH24Pct: DecimalString.default("50"),
  /** Max 24h-volume / liquidity ratio (wash/unstable sanity bound). */
  maxVolumeLiquidityRatio: DecimalString.default("10"),
});
export type ScannerThresholds = z.infer<typeof ScannerThresholdsSchema>;

export const DEFAULT_SCANNER_THRESHOLDS: ScannerThresholds =
  ScannerThresholdsSchema.parse({});

/** Rule ids evaluated by the M3 scanner (all required by default). */
export const SCANNER_RULE_IDS = [
  "liquidity-depth",
  "trading-activity",
  "pair-age",
  "data-freshness",
  "spike-guard",
  "volume-liquidity-sanity",
] as const;

/** Parse a decimal string defensively; null/invalid/non-finite → null. */
function dec(s: string | null | undefined): Decimal | null {
  if (s === null || s === undefined) return null;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function result(
  ruleId: string,
  verdict: RuleVerdict,
  observedValue: string | null,
  threshold: string,
  obs: NormalizedObservation,
): RuleResult {
  return RuleResultSchema.parse({
    ruleId,
    verdict,
    observedValue,
    threshold,
    source: obs.source,
    observedAt: obs.observedAt,
  });
}

/** 1. Pool liquidity meets the minimum (null → unknown). */
export function evalLiquidityDepth(
  obs: NormalizedObservation,
  t: ScannerThresholds,
): RuleResult {
  const liq = dec(obs.liquidityUsd);
  if (liq === null) {
    return result(
      "liquidity-depth",
      "unknown",
      null,
      `liquidityUsd >= ${t.minLiquidityUsd}`,
      obs,
    );
  }
  const verdict: RuleVerdict = liq.gte(t.minLiquidityUsd) ? "pass" : "fail";
  return result(
    "liquidity-depth",
    verdict,
    obs.liquidityUsd,
    `liquidityUsd >= ${t.minLiquidityUsd}`,
    obs,
  );
}

/**
 * 2. Recent trading activity: passes if 24h volume OR 24h trade count meets
 * its threshold. Fails only when at least one metric is present and neither
 * meets its bar; unknown when both are missing.
 */
export function evalTradingActivity(
  obs: NormalizedObservation,
  t: ScannerThresholds,
): RuleResult {
  const vol = dec(obs.volumeH24);
  const buys = obs.txnsH24Buys ?? 0;
  const sells = obs.txnsH24Sells ?? 0;
  const hasTxns = obs.txnsH24Buys !== null || obs.txnsH24Sells !== null;
  const txnsTotal = buys + sells;
  const threshold = `volumeH24 >= ${t.minVolumeH24Usd} OR txnsH24 >= ${t.minTxnsH24}`;
  const observedValue = `volumeH24=${obs.volumeH24 ?? "null"};txnsH24=${hasTxns ? String(txnsTotal) : "null"}`;
  if (vol === null && !hasTxns) {
    return result("trading-activity", "unknown", null, threshold, obs);
  }
  const volOk = vol !== null && vol.gte(t.minVolumeH24Usd);
  const txnOk = hasTxns && txnsTotal >= t.minTxnsH24;
  return result(
    "trading-activity",
    volOk || txnOk ? "pass" : "fail",
    observedValue,
    threshold,
    obs,
  );
}

/**
 * 3. Pair age: age is measured against the observation's own timestamp
 * (deterministic under replay), not wall-clock time.
 */
export function evalPairAge(
  obs: NormalizedObservation,
  t: ScannerThresholds,
): RuleResult {
  const threshold = `pairAgeMs >= ${t.minPairAgeMs}`;
  if (obs.pairCreatedAt === null) {
    return result("pair-age", "unknown", null, threshold, obs);
  }
  const ageMs = obs.observedAt - obs.pairCreatedAt;
  if (ageMs < 0) {
    // Created after it was observed: clock skew or bad data — not evidence.
    return result(
      "pair-age",
      "unknown",
      `pairCreatedAt=${obs.pairCreatedAt} after observedAt=${obs.observedAt}`,
      threshold,
      obs,
    );
  }
  return result(
    "pair-age",
    ageMs >= t.minPairAgeMs ? "pass" : "fail",
    `${ageMs}ms`,
    threshold,
    obs,
  );
}

/** 4. Data freshness: observation age at decision time within the max. */
export function evalDataFreshness(
  obs: NormalizedObservation,
  t: ScannerThresholds,
  nowMs: number,
): RuleResult {
  const threshold = `dataAgeMs <= ${t.maxDataAgeMs}`;
  const ageMs = nowMs - obs.observedAt;
  if (ageMs < 0) {
    return result(
      "data-freshness",
      "unknown",
      `observedAt=${obs.observedAt} in future vs nowMs=${nowMs} (clock skew)`,
      threshold,
      obs,
    );
  }
  return result(
    "data-freshness",
    ageMs <= t.maxDataAgeMs ? "pass" : "fail",
    `${ageMs}ms`,
    threshold,
    obs,
  );
}

/** 5. Abnormal spike guard: |24h change| beyond the bound fails. */
export function evalSpikeGuard(
  obs: NormalizedObservation,
  t: ScannerThresholds,
): RuleResult {
  const threshold = `|priceChangeH24| <= ${t.maxAbsChangeH24Pct}`;
  const chg = dec(obs.priceChangeH24);
  if (chg === null) {
    return result("spike-guard", "unknown", null, threshold, obs);
  }
  const verdict: RuleVerdict = chg.abs().lte(t.maxAbsChangeH24Pct)
    ? "pass"
    : "fail";
  return result(
    "spike-guard",
    verdict,
    obs.priceChangeH24,
    threshold,
    obs,
  );
}

/**
 * 6. Volume-to-liquidity sanity: extreme ratios suggest wash activity or
 * data inconsistency. Non-positive liquidity with volume is a fail
 * (unmeasurable impact); missing inputs are unknown.
 */
export function evalVolumeLiquiditySanity(
  obs: NormalizedObservation,
  t: ScannerThresholds,
): RuleResult {
  const threshold = `volumeH24/liquidityUsd <= ${t.maxVolumeLiquidityRatio}`;
  const vol = dec(obs.volumeH24);
  const liq = dec(obs.liquidityUsd);
  if (vol === null || liq === null) {
    return result("volume-liquidity-sanity", "unknown", null, threshold, obs);
  }
  if (liq.lte(0)) {
    return result(
      "volume-liquidity-sanity",
      "fail",
      `volumeH24=${obs.volumeH24};liquidityUsd=${obs.liquidityUsd} (non-positive liquidity)`,
      threshold,
      obs,
    );
  }
  const ratio = vol.div(liq);
  const verdict: RuleVerdict = ratio.lte(t.maxVolumeLiquidityRatio)
    ? "pass"
    : "fail";
  return result(
    "volume-liquidity-sanity",
    verdict,
    ratio.toFixed(4),
    threshold,
    obs,
  );
}

/** Evaluate all six rules in a fixed order. */
export function evalAllRules(
  obs: NormalizedObservation,
  t: ScannerThresholds,
  nowMs: number,
): RuleResult[] {
  return [
    evalLiquidityDepth(obs, t),
    evalTradingActivity(obs, t),
    evalPairAge(obs, t),
    evalDataFreshness(obs, t, nowMs),
    evalSpikeGuard(obs, t),
    evalVolumeLiquiditySanity(obs, t),
  ];
}

/**
 * Outcome derivation (§10): REJECT when ANY evaluated rule fails (a known-bad
 * signal is never ACCEPT, even outside the caller's required subset —
 * narrowing requiredIds cannot hide a failure), else REVIEW when any required
 * rule is unknown/incomplete, else ACCEPT. An "unknown" can never produce
 * ACCEPT — enforced here, not just by convention.
 */
export function deriveOutcome(
  rules: RuleResult[],
  requiredIds: readonly string[] = SCANNER_RULE_IDS,
): ScannerOutcome {
  if (rules.some((r) => r.verdict === "fail")) return "REJECT";
  const required = rules.filter((r) => requiredIds.includes(r.ruleId));
  if (required.some((r) => r.verdict === "unknown")) return "REVIEW";
  // Vacuous acceptance is forbidden: every required rule must be present
  // and passing before ACCEPT is possible.
  if (required.length < requiredIds.length) return "REVIEW";
  if (required.some((r) => r.verdict !== "pass")) return "REVIEW";
  return "ACCEPT";
}
