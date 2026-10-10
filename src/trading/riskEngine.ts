/**
 * Deterministic pre-order risk engine (M4, spec §14). PAPER-ONLY.
 *
 * Every check entry asserts EXECUTION_MODE === "PAPER" and fails closed
 * otherwise. The engine is a pure function: it never places orders, never
 * closes positions, never auto-liquidates, and performs no I/O.
 *
 * Policy notes (spec §14):
 * - Checks run immediately before simulated order creation, on the freshest
 *   data the caller provides. Missing, stale, contradictory, or invalid
 *   critical data rejects the entry (fail closed).
 * - Emergency stop blocks new entries (BUY). Simulated exits (SELL) stay
 *   permitted so risk can be reduced; the stop never auto-liquidates and can
 *   never create real orders (there is no real-order path anywhere).
 * - Every rejection carries machine-readable reason codes in `reasons`.
 * - Duplicate prevention arrives via an injected `isDuplicate` hook so this
 *   module stays I/O-free; production wiring must back it with a database
 *   UNIQUE constraint on the idempotency key (see src/trading/orders.ts),
 *   not application logic alone (§15.3).
 */

import { assertPaperMode } from "../safety/executionMode.js";
import type { OrderSide } from "./orders.js";

/** All thresholds are constructor params; defaults are spec §5.5 values. */
export interface RiskThresholds {
  maxPositionFraction: number;
  maxExposurePerTokenFraction: number;
  maxTotalExposureFraction: number;
  maxOpenPositions: number;
  maxDailyLossFraction: number;
  maxDrawdownFraction: number;
  maxEntryCostFraction: number;
  minPoolLiquidityUsd: number;
  maxPositionShareOfLiquidity: number;
  maxScannerDataAgeMs: number;
  maxRiskDataAgeMs: number;
  maxExecutionDataAgeMs: number;
  cooldownAfterFailuresMs: number;
  consecutiveFailuresForCooldown: number;
}

/**
 * Spec §5.5 initial defaults. These are configurable, validated starting
 * points, NOT recommendations.
 */
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  maxPositionFraction: 0.04,
  maxExposurePerTokenFraction: 0.04,
  maxTotalExposureFraction: 0.3,
  maxOpenPositions: 6,
  maxDailyLossFraction: 0.08,
  maxDrawdownFraction: 0.2,
  maxEntryCostFraction: 0.04,
  minPoolLiquidityUsd: 40_000,
  maxPositionShareOfLiquidity: 0.005,
  maxScannerDataAgeMs: 90_000,
  maxRiskDataAgeMs: 30_000,
  maxExecutionDataAgeMs: 10_000,
  cooldownAfterFailuresMs: 15 * 60_000,
  consecutiveFailuresForCooldown: 3,
};

export interface PositionExposure {
  token: string;
  /** Current simulated position value in lamports (bigint; no float money). */
  valueLamports: bigint;
}

export interface RiskCheckInput {
  nowMs: number;
  side: OrderSide;
  /** Token/market identifier for the proposed order. */
  token: string;
  /** Proposed position notional in lamports (BUY) or closing value (SELL). */
  notionalLamports: bigint;
  availableCashLamports: bigint;
  currentEquityLamports: bigint;
  startOfDayEquityLamports: bigint;
  /** UTC midnight (ms) that startOfDayEquity refers to; a later UTC day resets the daily-loss gate. */
  startOfDayUtcMs: number;
  peakEquityLamports: bigint;
  openPositionCount: number;
  openPositions: readonly PositionExposure[];
  /** Pool liquidity in USD, or null when unknown (unknown = reject). */
  poolLiquidityUsd: number | null;
  /** Proposed notional as a fraction of pool liquidity, or null when unknown (unknown = reject). */
  positionShareOfLiquidity: number | null;
  /** Modeled entry slippage + impact fraction (BUY), or null when unknown (unknown = reject). */
  modeledEntryCostFraction: number | null;
  scannerDataAgeMs: number | null;
  riskDataAgeMs: number | null;
  consecutiveFailures: number;
  lastFailureMs: number | null;
  idempotencyKey: string;
  /** Duplicate-order hook; must return true if the key was seen before. */
  isDuplicate: (key: string) => boolean;
  emergencyStop: boolean;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: string[];
}

const MS_PER_DAY = 86_400_000;
const BPS = 10_000n;

function fractionToBp(f: number): bigint {
  return BigInt(Math.round(f * 10_000));
}

/**
 * True when part/whole strictly exceeds the limit fraction. Exactly-at-limit
 * is allowed. A non-positive base is treated as a breach (fail closed).
 */
function exceedsLimit(part: bigint, whole: bigint, limitFraction: number): boolean {
  if (whole <= 0n || part < 0n) return true;
  return part * BPS > whole * fractionToBp(limitFraction);
}

function isFiniteFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function validateThresholds(t: RiskThresholds): void {
  const fracs: (keyof RiskThresholds)[] = [
    "maxPositionFraction",
    "maxExposurePerTokenFraction",
    "maxTotalExposureFraction",
    "maxDailyLossFraction",
    "maxDrawdownFraction",
    "maxEntryCostFraction",
    "maxPositionShareOfLiquidity",
  ];
  for (const k of fracs) {
    if (!isFiniteFraction(t[k])) {
      throw new Error(`invalid risk threshold ${k}: ${String(t[k])} (need finite fraction 0..1)`);
    }
  }
  if (!Number.isInteger(t.maxOpenPositions) || t.maxOpenPositions <= 0) {
    throw new Error(`invalid risk threshold maxOpenPositions: ${String(t.maxOpenPositions)}`);
  }
  if (!Number.isInteger(t.consecutiveFailuresForCooldown) || t.consecutiveFailuresForCooldown <= 0) {
    throw new Error(
      `invalid risk threshold consecutiveFailuresForCooldown: ${String(t.consecutiveFailuresForCooldown)}`,
    );
  }
  const ages: (keyof RiskThresholds)[] = [
    "maxScannerDataAgeMs",
    "maxRiskDataAgeMs",
    "maxExecutionDataAgeMs",
    "cooldownAfterFailuresMs",
  ];
  for (const k of ages) {
    if (!Number.isInteger(t[k]) || (t[k] as number) <= 0) {
      throw new Error(`invalid risk threshold ${k}: ${String(t[k])} (need positive integer ms)`);
    }
  }
  if (typeof t.minPoolLiquidityUsd !== "number" || !Number.isFinite(t.minPoolLiquidityUsd) || t.minPoolLiquidityUsd <= 0) {
    throw new Error(`invalid risk threshold minPoolLiquidityUsd: ${String(t.minPoolLiquidityUsd)}`);
  }
}

export class RiskEngine {
  readonly thresholds: RiskThresholds;

  constructor(thresholds: Partial<RiskThresholds> = {}) {
    const merged: RiskThresholds = { ...DEFAULT_RISK_THRESHOLDS, ...thresholds };
    validateThresholds(merged);
    this.thresholds = merged;
  }

  check(input: RiskCheckInput): RiskDecision {
    assertPaperMode();
    const t = this.thresholds;
    const reasons: string[] = [];
    const block = (reason: string): void => {
      reasons.push(reason);
    };

    // 1. Emergency stop blocks new entries. Exits (SELL) stay allowed so
    //    simulated risk can be reduced; nothing here liquidates anything.
    if (input.emergencyStop && input.side === "BUY") {
      block("emergency-stop");
    }

    // 2. Duplicate-order hook applies to both sides. A throwing hook fails
    //    closed: an unverifiable key must not create a second order.
    let duplicate = false;
    let hookFailed = false;
    try {
      duplicate = input.isDuplicate(input.idempotencyKey);
    } catch {
      hookFailed = true;
    }
    if (hookFailed) block("duplicate-check-unavailable");
    else if (duplicate) block("duplicate-order");

    // 3. Accounting-state validity (protection against invalid balances).
    if (input.notionalLamports <= 0n) block("invalid-notional");
    if (input.currentEquityLamports <= 0n) block("invalid-equity");
    if (input.startOfDayEquityLamports <= 0n) block("invalid-start-of-day-equity");
    if (input.peakEquityLamports <= 0n) block("invalid-peak-equity");
    if (input.availableCashLamports < 0n) block("invalid-cash");
    if (input.openPositionCount < 0) block("invalid-open-count");

    // 4. Freshness gates (both sides: exits also need trustworthy data).
    if (input.scannerDataAgeMs === null || !Number.isFinite(input.scannerDataAgeMs) || input.scannerDataAgeMs < 0) {
      block("missing-scanner-data");
    } else if (input.scannerDataAgeMs > t.maxScannerDataAgeMs) {
      block("stale-scanner-data");
    }
    if (input.riskDataAgeMs === null || !Number.isFinite(input.riskDataAgeMs) || input.riskDataAgeMs < 0) {
      block("missing-risk-data");
    } else if (input.riskDataAgeMs > t.maxRiskDataAgeMs) {
      block("stale-risk-data");
    }

    // Exits skip exposure/loss gates: closing reduces risk.
    if (input.side === "SELL") {
      return { allowed: reasons.length === 0, reasons };
    }

    // 5. Cash coverage (negative-balance prevention at the gate; the ledger
    //    enforces it again at fill time).
    if (input.notionalLamports > input.availableCashLamports) {
      block("insufficient-cash");
    }

    // 6. Size / exposure gates (bigint math; strictly-greater breaches).
    if (exceedsLimit(input.notionalLamports, input.currentEquityLamports, t.maxPositionFraction)) {
      block("max-position-size");
    }
    let tokenExposure = 0n;
    for (const p of input.openPositions) {
      if (p.valueLamports < 0n) {
        block("invalid-position-value");
        break;
      }
      if (p.token === input.token) tokenExposure += p.valueLamports;
    }
    if (exceedsLimit(tokenExposure + input.notionalLamports, input.currentEquityLamports, t.maxExposurePerTokenFraction)) {
      block("max-exposure-per-token");
    }
    let totalExposure = 0n;
    for (const p of input.openPositions) {
      if (p.valueLamports >= 0n) totalExposure += p.valueLamports;
    }
    if (exceedsLimit(totalExposure + input.notionalLamports, input.currentEquityLamports, t.maxTotalExposureFraction)) {
      block("max-total-exposure");
    }
    if (input.openPositionCount >= t.maxOpenPositions) {
      block("max-open-positions");
    }

    // 7. Daily simulated-loss gate: blocks entries while the current UTC day
    //    is in breach. A new UTC day resets it (caller refreshes the
    //    start-of-day reference).
    const sameUtcDay =
      Math.floor(input.nowMs / MS_PER_DAY) === Math.floor(input.startOfDayUtcMs / MS_PER_DAY);
    if (
      sameUtcDay &&
      input.startOfDayEquityLamports > 0n &&
      input.currentEquityLamports < input.startOfDayEquityLamports &&
      exceedsLimit(
        input.startOfDayEquityLamports - input.currentEquityLamports,
        input.startOfDayEquityLamports,
        t.maxDailyLossFraction,
      )
    ) {
      block("daily-loss-limit");
    }

    // 8. Drawdown gate (manual-reset emergency-stop condition is owned by the
    //    caller via the emergencyStop flag; this gate blocks entries now).
    if (
      input.peakEquityLamports > 0n &&
      input.currentEquityLamports < input.peakEquityLamports &&
      exceedsLimit(
        input.peakEquityLamports - input.currentEquityLamports,
        input.peakEquityLamports,
        t.maxDrawdownFraction,
      )
    ) {
      block("drawdown-breach");
    }

    // 9. Liquidity gates.
    if (input.poolLiquidityUsd === null || !Number.isFinite(input.poolLiquidityUsd)) {
      block("missing-liquidity");
    } else if (input.poolLiquidityUsd < t.minPoolLiquidityUsd) {
      block("low-liquidity");
    }
    if (input.positionShareOfLiquidity === null || !Number.isFinite(input.positionShareOfLiquidity)) {
      block("missing-liquidity-share");
    } else if (input.positionShareOfLiquidity > t.maxPositionShareOfLiquidity) {
      block("excessive-liquidity-share");
    }

    // 10. Modeled entry-cost gate.
    if (input.modeledEntryCostFraction === null || !Number.isFinite(input.modeledEntryCostFraction)) {
      block("missing-cost-estimate");
    } else if (input.modeledEntryCostFraction > t.maxEntryCostFraction) {
      block("excessive-entry-cost");
    }

    // 11. Cooldown after repeated failures. Clock skew (negative elapsed)
    //     fails closed into the cooldown.
    if (
      input.consecutiveFailures >= t.consecutiveFailuresForCooldown &&
      input.lastFailureMs !== null &&
      input.nowMs - input.lastFailureMs < t.cooldownAfterFailuresMs
    ) {
      block("cooldown");
    }

    return { allowed: reasons.length === 0, reasons };
  }
}
