/**
 * BaselineV1 strategy skeleton, Milestone 3 (spec §13, §13.1).
 *
 * PAPER-ONLY and deliberately simple: a transparent baseline so the pipeline
 * can be exercised and measured. NOT claimed to be profitable (§13.1).
 *
 * Entry (all required): scanner ACCEPT + all required risk PASS + momentum
 * band (positive short-window momentum, no extreme spike) + modeled-cost cap.
 * Exits: stop-loss / take-profit / trailing-stop / time-stop params plus
 * forced exits on risk FAIL, liquidity collapse, or stale data per policy.
 * Sizing: fixed fraction of equity, capped by risk limits (enforced later by
 * the deterministic risk engine, M4 — recorded here as proposed size only).
 *
 * Every decision records the strategy version + config. The strategy cannot
 * bypass the risk engine (M4); an ENTRY here is a proposal, not an order.
 */
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { NormalizedObservation } from "../providers/types.js";
import type { ScannerResult } from "../scanner/scanner.js";
import type { RiskReport } from "../risk/checks.js";
import { RISK_CHECK_IDS } from "../risk/checks.js";
import { SCANNER_RULE_IDS } from "../scanner/rules.js";

export const BASELINE_V1 = "baseline-v1" as const;

const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "not a plain decimal string");

/** BaselineV1 config. Defaults are starting points, not recommendations. */
export const BaselineV1ConfigSchema = z.object({
  version: z.literal(BASELINE_V1).default(BASELINE_V1),
  /** Min 24h change (%) for "positive momentum" entry leg. */
  minMomentumH24Pct: DecimalString.default("0"),
  /** Max |24h change| (%) — above this we refuse to chase. */
  maxChaseH24Pct: DecimalString.default("25"),
  /** Min volume/liquidity ratio for the entry band (proves tradeability). */
  minVolumeLiquidityRatio: DecimalString.default("0.01"),
  /** Max ratio for the entry band (above = overheated). */
  maxVolumeLiquidityRatio: DecimalString.default("5"),
  /** Max modeled entry cost as a fraction of notional (0-1). */
  maxModeledCostFraction: DecimalString.default("0.04"),
  /** Stop-loss: exit when price falls this fraction below entry (0-1). */
  stopLossFraction: DecimalString.default("0.10"),
  /** Take-profit: exit when price rises this fraction above entry (>=0). */
  takeProfitFraction: DecimalString.default("0.20"),
  /** Trailing stop drawdown from peak fraction (0-1). */
  trailingStopFraction: DecimalString.default("0.12"),
  /** Time stop: exit after this many ms in position. */
  timeStopMs: z.number().int().positive().default(24 * 3_600_000),
  /** Fixed fraction of equity proposed per position (0-1, capped by M4). */
  positionFraction: DecimalString.default("0.02"),
});
export type BaselineV1Config = z.infer<typeof BaselineV1ConfigSchema>;

export const DEFAULT_BASELINE_V1_CONFIG: BaselineV1Config =
  BaselineV1ConfigSchema.parse({});

export const StrategyDecisionTypeSchema = z.enum([
  "ENTRY",
  "EXIT",
  "HOLD",
  "REJECT",
]);
export type StrategyDecisionType = z.infer<typeof StrategyDecisionTypeSchema>;

export const StrategyDecisionSchema = z.object({
  candidateId: z.string().min(1).max(160),
  decidedAt: z.number().int().nonnegative(),
  decision: StrategyDecisionTypeSchema,
  strategyVersion: z.literal(BASELINE_V1),
  /** Snapshot of the config that produced this decision (audit trail). */
  config: BaselineV1ConfigSchema,
  /** Supporting metrics (decimal strings; never float money). */
  metrics: z.record(z.string(), z.string()),
  entryConditions: z.array(z.string().max(240)),
  exitConditions: z.array(z.string().max(240)),
  /** Proposed size as fraction-of-equity decimal string (M4 caps it). */
  proposedSizeFraction: z.string().max(64),
  /** Modeled entry cost fraction decimal string ("unknown" when unmeasurable). */
  estimatedCostFraction: z.string().max(64),
  reasons: z.array(z.string().max(500)),
  dataFresh: z.boolean(),
});
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

function dec(s: string | null | undefined): Decimal | null {
  if (s === null || s === undefined) return null;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export interface EntryInputs {
  obs: NormalizedObservation;
  scan: ScannerResult;
  risk: RiskReport;
  /** Modeled entry cost fraction (decimal string) or null when unmeasurable. */
  modeledCostFraction: string | null;
  /** Observation age at decision time; null when unmeasurable. */
  dataAgeMs: number | null;
  /** Max acceptable data age; defaults to the 90s scanner bound (§5.5). */
  maxDataAgeMs?: number;
  /** Config overrides (recorded with the decision). */
  config?: Partial<BaselineV1Config>;
}

function reject(
  obs: NormalizedObservation,
  decidedAt: number,
  cfg: BaselineV1Config,
  reasons: string[],
  metrics: Record<string, string>,
  dataFresh: boolean,
): StrategyDecision {
  return StrategyDecisionSchema.parse({
    candidateId: `${obs.mint}|${obs.pairAddress}`,
    decidedAt,
    decision: "REJECT",
    strategyVersion: BASELINE_V1,
    config: cfg,
    metrics,
    entryConditions: [],
    exitConditions: [
      `stop-loss ${cfg.stopLossFraction} below entry`,
      `take-profit ${cfg.takeProfitFraction} above entry`,
      `trailing stop ${cfg.trailingStopFraction} from peak`,
      `time stop ${cfg.timeStopMs}ms`,
      "forced exit on risk FAIL, liquidity collapse, or stale data per policy",
    ],
    proposedSizeFraction: "0",
    estimatedCostFraction: "unknown",
    reasons,
    dataFresh,
  });
}

/**
 * BaselineV1 entry evaluation. Returns ENTRY only when every gate holds;
 * otherwise REJECT with the blocking reasons (never HOLD-ambiguous at entry).
 */
export function evaluateEntry(inputs: EntryInputs): StrategyDecision {
  const cfg: BaselineV1Config = BaselineV1ConfigSchema.parse({
    ...inputs.config,
  });
  const { obs, scan, risk } = inputs;
  const decidedAt = inputs.dataAgeMs === null ? obs.observedAt : obs.observedAt + inputs.dataAgeMs;
  const maxAge = inputs.maxDataAgeMs ?? 90_000;
  const dataFresh =
    inputs.dataAgeMs !== null && inputs.dataAgeMs >= 0 && inputs.dataAgeMs <= maxAge;

  const chg = dec(obs.priceChangeH24);
  const vol = dec(obs.volumeH24);
  const liq = dec(obs.liquidityUsd);
  let volLiq: Decimal | null = null;
  if (vol !== null && liq !== null && liq.gt(0)) volLiq = vol.div(liq);
  const cost = dec(inputs.modeledCostFraction);

  const metrics: Record<string, string> = {
    priceChangeH24: chg === null ? "unknown" : obs.priceChangeH24 ?? "unknown",
    volumeLiquidityRatio: volLiq === null ? "unknown" : volLiq.toFixed(6),
    modeledCostFraction: cost === null ? "unknown" : inputs.modeledCostFraction ?? "unknown",
    scanOutcome: scan.outcome,
    riskEntryAllowed: String(risk.entryAllowed),
  };

  const reasons: string[] = [];
  if (scan.outcome !== "ACCEPT") {
    reasons.push(`scanner outcome is ${scan.outcome} (need ACCEPT).`);
  }
  if (!risk.entryAllowed) {
    const bad = risk.checks
      .filter((c) => c.status !== "PASS")
      .map((c) => `${c.checkId}=${c.status}`)
      .join(", ");
    reasons.push(`risk entry bar not met: ${bad === "" ? "no passing checks" : bad}.`);
  }
  // Momentum band: positive but not extreme.
  if (chg === null) {
    reasons.push("momentum unknown (priceChangeH24 missing) — no chase on missing data.");
  } else if (chg.lt(cfg.minMomentumH24Pct)) {
    reasons.push(
      `no positive momentum (priceChangeH24=${obs.priceChangeH24} < ${cfg.minMomentumH24Pct}).`,
    );
  } else if (chg.abs().gt(cfg.maxChaseH24Pct)) {
    reasons.push(
      `extreme recent move (priceChangeH24=${obs.priceChangeH24}, |.| > ${cfg.maxChaseH24Pct}) — refuse to chase.`,
    );
  }
  // Volume-to-liquidity band.
  if (volLiq === null) {
    reasons.push("volume/liquidity ratio unmeasurable (missing volume or liquidity).");
  } else if (
    volLiq.lt(cfg.minVolumeLiquidityRatio) ||
    volLiq.gt(cfg.maxVolumeLiquidityRatio)
  ) {
    reasons.push(
      `volume/liquidity ${volLiq.toFixed(6)} outside band [${cfg.minVolumeLiquidityRatio}, ${cfg.maxVolumeLiquidityRatio}].`,
    );
  }
  // Modeled-cost cap.
  if (cost === null) {
    reasons.push("modeled entry cost unknown — cannot verify cost cap.");
  } else if (cost.gt(cfg.maxModeledCostFraction)) {
    reasons.push(
      `modeled cost ${inputs.modeledCostFraction} exceeds cap ${cfg.maxModeledCostFraction}.`,
    );
  }
  if (!dataFresh) {
    reasons.push(
      inputs.dataAgeMs === null
        ? "data freshness unknown — stale data fails safe."
        : `data stale (age ${inputs.dataAgeMs}ms > max ${maxAge}ms).`,
    );
  }

  if (reasons.length > 0) {
    return reject(obs, decidedAt, cfg, reasons, metrics, dataFresh);
  }
  return StrategyDecisionSchema.parse({
    candidateId: `${obs.mint}|${obs.pairAddress}`,
    decidedAt,
    decision: "ENTRY",
    strategyVersion: BASELINE_V1,
    config: cfg,
    metrics,
    entryConditions: [
      "scanner ACCEPT",
      `all required risk checks PASS (${RISK_CHECK_IDS.length} of ${RISK_CHECK_IDS.length})`,
      `momentum in (${cfg.minMomentumH24Pct}, ${cfg.maxChaseH24Pct}]`,
      `volume/liquidity in [${cfg.minVolumeLiquidityRatio}, ${cfg.maxVolumeLiquidityRatio}]`,
      `modeled cost <= ${cfg.maxModeledCostFraction}`,
    ],
    exitConditions: [
      `stop-loss ${cfg.stopLossFraction} below entry`,
      `take-profit ${cfg.takeProfitFraction} above entry`,
      `trailing stop ${cfg.trailingStopFraction} from peak`,
      `time stop ${cfg.timeStopMs}ms`,
      "forced exit on risk FAIL, liquidity collapse, or stale data per policy",
    ],
    proposedSizeFraction: cfg.positionFraction,
    estimatedCostFraction: inputs.modeledCostFraction ?? "unknown",
    reasons: ["all BaselineV1 entry gates hold; proposal only — M4 risk engine decides."],
    dataFresh,
  });
}

/** Exit params carried with an open paper position (evaluated by M4+). */
export const ExitStateSchema = z.object({
  entryPrice: DecimalString,
  peakPrice: DecimalString,
  enteredAt: z.number().int().nonnegative(),
  stopLossFraction: DecimalString,
  takeProfitFraction: DecimalString,
  trailingStopFraction: DecimalString,
  timeStopMs: z.number().int().positive(),
});
export type ExitState = z.infer<typeof ExitStateSchema>;

export interface ExitTick {
  price: string;
  nowMs: number;
  /** True when a required risk check newly FAILs. */
  riskFailed: boolean;
  /** True when liquidity collapsed below the entry bar. */
  liquidityCollapsed: boolean;
  /** True when data is stale per policy. */
  dataStale: boolean;
}

/**
 * Exit evaluation skeleton: stop-loss / take-profit / trailing-stop /
 * time-stop, plus forced exits (risk FAIL, liquidity collapse, stale data).
 * Returns the exit reason or null (hold). Pure decimal math, no floats.
 */
export function evaluateExit(state: ExitState, tick: ExitTick): string | null {
  if (tick.riskFailed) return "forced: risk check FAIL appeared";
  if (tick.liquidityCollapsed) return "forced: liquidity collapse";
  if (tick.dataStale) return "forced: stale data per policy";
  const parsed = ExitStateSchema.safeParse(state);
  if (!parsed.success) return "forced: invalid exit state";
  let price: Decimal;
  let entry: Decimal;
  let peak: Decimal;
  try {
    price = new Decimal(tick.price);
    entry = new Decimal(state.entryPrice);
    peak = new Decimal(state.peakPrice);
    if (!price.isFinite() || !entry.isFinite() || !peak.isFinite()) {
      return "forced: non-finite price";
    }
  } catch {
    return "forced: unparseable price";
  }
  if (entry.lte(0) || peak.lte(0) || price.lte(0)) {
    return "forced: non-positive price";
  }
  const stopLoss = new Decimal(state.stopLossFraction);
  const takeProfit = new Decimal(state.takeProfitFraction);
  const trailing = new Decimal(state.trailingStopFraction);
  if (price.div(entry).minus(1).lte(stopLoss.neg())) {
    return `stop-loss: price ${tick.price} >= ${state.stopLossFraction} below entry`;
  }
  if (price.div(entry).minus(1).gte(takeProfit)) {
    return `take-profit: price ${tick.price} >= ${state.takeProfitFraction} above entry`;
  }
  const ref = Decimal.max(peak, price);
  void ref;
  if (peak.gt(price) && peak.minus(price).div(peak).gte(trailing)) {
    return `trailing-stop: ${state.trailingStopFraction} drawdown from peak ${state.peakPrice}`;
  }
  if (tick.nowMs - state.enteredAt >= state.timeStopMs) {
    return `time-stop: held ${tick.nowMs - state.enteredAt}ms >= ${state.timeStopMs}ms`;
  }
  return null;
}

/** Re-export the gate rule sets so callers cite one source of truth. */
export { RISK_CHECK_IDS, SCANNER_RULE_IDS };
