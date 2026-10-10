/**
 * Modeled execution for simulated fills (M4, spec §15.4). PAPER-ONLY.
 *
 * Pure function of caller-supplied observations: NO network calls, NO signing
 * or sending primitives, NO wallet access. All entry points assert
 * EXECUTION_MODE === "PAPER" and fail closed otherwise.
 *
 * Returns four DISTINCT values that must not be conflated (spec §15.4):
 *   observedPrice   — last market price as observed (input, echoed)
 *   executablePrice — price after latency drift + spread/slippage + impact
 *   fillPrice       — executable price minus the adverse-selection draw
 *   valuationNote   — how the fourth value (portfolio valuation) must be
 *                     derived: at a FRESH mark, never at the fill price
 *
 * The model keeps BUY and SELL cost legs separate (buyFees vs sellFees) so
 * the ledger can post them to different legs. Every assumption is documented
 * in docs/EXECUTION_MODEL.md and labeled "modeled" in outputs.
 */

import { assertPaperMode } from "../safety/executionMode.js";
import { Decimal } from "decimal.js";
import type { OrderSide } from "./orders.js";

export interface ExecutionParams {
  /** Skewed latency window in ms (default 400–3000, §15.4). */
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Exponential skew: sample = min + (max−min) * u^skew. */
  latencySkew: number;
  /** Per-second drift sigma applied over sampled latency. */
  driftSigmaPerSecond: number;
  /** Spread fraction per unit of observed volatility (fraction of price). */
  spreadPerVolatility: number;
  /** Assumed quote-side reserve share of reported total liquidity (default 0.5). */
  quoteReserveShare: number;
  /** DEX/pool fee fraction when the pair's true fee is unknown (default 0.003). */
  defaultPoolFeeFraction: number;
  /** Flat network + priority + modeled tip cost in lamports, BUY leg. */
  buyFlatFeeLamports: bigint;
  /** Flat network + priority + modeled tip cost in lamports, SELL leg. */
  sellFlatFeeLamports: bigint;
  /** Adverse-selection / MEV draw: uniform fraction in [0, maxAdverseDrawFraction]. */
  maxAdverseDrawFraction: number;
  /** Baseline failure probability per attempt (before volatility/liquidity uplift). */
  baseFailureProbability: number;
  /** Extra failure probability per unit of volatility. */
  failurePerVolatility: number;
  /** Liquidity (USD) below which the low-liquidity failure uplift applies. */
  lowLiquidityUsd: number;
  /** Extra failure probability added when liquidity is below lowLiquidityUsd. */
  lowLiquidityFailureUplift: number;
  /** Max executable fraction of quote-side reserves before a partial fill. */
  maxFillShareOfReserves: number;
}

/** Documented defaults; see docs/EXECUTION_MODEL.md for why each is modeled. */
export const DEFAULT_EXECUTION_PARAMS: ExecutionParams = {
  minLatencyMs: 400,
  maxLatencyMs: 3000,
  latencySkew: 2,
  driftSigmaPerSecond: 0.02,
  spreadPerVolatility: 0.5,
  quoteReserveShare: 0.5,
  defaultPoolFeeFraction: 0.003,
  buyFlatFeeLamports: 10_000n,
  sellFlatFeeLamports: 10_000n,
  maxAdverseDrawFraction: 0.01,
  baseFailureProbability: 0.02,
  failurePerVolatility: 0.5,
  lowLiquidityUsd: 40_000,
  lowLiquidityFailureUplift: 0.1,
  maxFillShareOfReserves: 0.5,
};

export interface ExecutionQuote {
  side: OrderSide;
  /** Decimal price string, non-negative. */
  observedPrice: string;
  /** Fresh execution-time price; required when latency is modeled. */
  executionPrice: string | null;
  executionPriceAgeMs: number | null;
  maxExecutionDataAgeMs: number;
  observedVolatility: number;
  poolLiquidityUsd: number | null;
  verifiedPoolFeeFraction: number | null;
  notionalLamports: bigint;
}

export type ExecutionFailure =
  | { ok: true }
  | { ok: false; reason: string };

export interface ModeledExecution {
  side: OrderSide;
  observedPrice: string;
  executablePrice: string;
  fillPrice: string;
  /** Fraction of the requested notional that fills (1 = full, <1 = partial). */
  fillFraction: string;
  sampledLatencyMs: number;
  buyFeesLamports: bigint;
  sellFeesLamports: bigint;
  failure: ExecutionFailure;
  valuationNote: string;
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;

function parsePrice(label: string, raw: string): Decimal {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) {
    throw new Error(`${label} must be a non-negative decimal string (got "${raw}")`);
  }
  const d = new Decimal(raw);
  if (d.isZero()) throw new Error(`${label} must be positive`);
  return d;
}

/** Deterministic PRNG (mulberry32) so modeled draws are reproducible in tests. */
export function mulberry32(seed: number): () => number {
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validateParams(p: ExecutionParams): void {
  const fail = (m: string): never => {
    throw new Error(`invalid execution param: ${m}`);
  };
  if (!Number.isInteger(p.minLatencyMs) || p.minLatencyMs < 0) fail("minLatencyMs");
  if (!Number.isInteger(p.maxLatencyMs) || p.maxLatencyMs < p.minLatencyMs) fail("maxLatencyMs");
  if (!Number.isFinite(p.latencySkew) || p.latencySkew <= 0) fail("latencySkew");
  for (const k of [
    "driftSigmaPerSecond",
    "spreadPerVolatility",
    "defaultPoolFeeFraction",
    "maxAdverseDrawFraction",
    "baseFailureProbability",
    "failurePerVolatility",
    "lowLiquidityFailureUplift",
    "maxFillShareOfReserves",
  ] as const) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(k);
  }
  if (p.quoteReserveShare <= 0 || p.quoteReserveShare >= 1) fail("quoteReserveShare");
  if (p.maxFillShareOfReserves <= 0 || p.maxFillShareOfReserves > 1) fail("maxFillShareOfReserves");
  if (p.baseFailureProbability > 1) fail("baseFailureProbability");
  if (p.lowLiquidityUsd <= 0 || !Number.isFinite(p.lowLiquidityUsd)) fail("lowLiquidityUsd");
  if (p.buyFlatFeeLamports < 0n || p.sellFlatFeeLamports < 0n) fail("flat fees");
}

/**
 * Model a simulated fill. Deterministic given (quote, seed): the same inputs
 * always produce the same draws, so tests can pin vectors.
 */
export function modelExecution(
  quote: ExecutionQuote,
  params: ExecutionParams = DEFAULT_EXECUTION_PARAMS,
  seed = 1,
): ModeledExecution {
  assertPaperMode();
  validateParams(params);
  if (quote.side !== "BUY" && quote.side !== "SELL") {
    throw new Error(`side must be BUY or SELL (got ${String(quote.side)})`);
  }
  const observed = parsePrice("observedPrice", quote.observedPrice);
  if (quote.notionalLamports <= 0n) throw new Error("notionalLamports must be positive");
  if (!Number.isFinite(quote.observedVolatility) || quote.observedVolatility < 0) {
    throw new Error("observedVolatility must be a finite number >= 0");
  }
  if (quote.poolLiquidityUsd !== null) {
    if (!Number.isFinite(quote.poolLiquidityUsd) || quote.poolLiquidityUsd <= 0) {
      throw new Error("poolLiquidityUsd must be positive or null");
    }
  }
  if (quote.verifiedPoolFeeFraction !== null) {
    if (
      !Number.isFinite(quote.verifiedPoolFeeFraction) ||
      quote.verifiedPoolFeeFraction < 0 ||
      quote.verifiedPoolFeeFraction > 1
    ) {
      throw new Error("verifiedPoolFeeFraction must be within 0..1 or null");
    }
  }

  const rand = mulberry32(seed);

  // 1. Latency draw (skewed toward the fast end) + drift during the delay.
  const u = rand();
  const latencyMs =
    params.minLatencyMs + (params.maxLatencyMs - params.minLatencyMs) * Math.pow(u, params.latencySkew);
  const sampledLatencyMs = Math.round(latencyMs);

  // Conservative policy on stale execution data: with no fresh execution-time
  // observation we do NOT fill at a stale price — the attempt fails.
  let latencyBase = observed;
  if (quote.executionPrice !== null) {
    const age = quote.executionPriceAgeMs;
    if (age === null || !Number.isInteger(age) || age < 0 || age > quote.maxExecutionDataAgeMs) {
      return failed(quote, sampledLatencyMs, "stale-execution-price");
    }
    latencyBase = parsePrice("executionPrice", quote.executionPrice);
  }
  // Drift magnitude ~ sigma * sqrt(t); sign from a second draw. Applied to
  // the freshest price, never invented from nothing: with no execution price
  // the observed price stands (its age is policed by the risk engine).
  const driftDraw = rand();
  const driftSign = driftDraw < 0.5 ? -1 : 1;
  const driftMag = params.driftSigmaPerSecond * Math.sqrt(Math.max(0, latencyMs) / 1000);
  const drifted = latencyBase.mul(1 + (driftSign * driftMag) / 2);

  // 2. Constant-product impact (assumption: quote reserves ~= share of
  //    reported liquidity; notional converted at observed price — all modeled).
  //    impact ≈ tradeSize / (reserves + tradeSize).
  let impactFraction = 0;
  let fillFraction = "1";
  if (quote.poolLiquidityUsd !== null) {
    const quoteReservesUsd = quote.poolLiquidityUsd * params.quoteReserveShare;
    const notionalUsd = Number(new Decimal(quote.notionalLamports.toString()).mul(observed).toString());
    if (Number.isFinite(notionalUsd) && quoteReservesUsd > 0) {
      impactFraction = notionalUsd / (quoteReservesUsd + notionalUsd);
      const maxNotionalUsd = quoteReservesUsd * params.maxFillShareOfReserves;
      if (notionalUsd > maxNotionalUsd && maxNotionalUsd > 0) {
        fillFraction = new Decimal(maxNotionalUsd).div(notionalUsd).toString();
      }
    }
  }

  // 3. Spread/slippage beyond impact, scaled by volatility (against trader).
  const spreadFraction = params.spreadPerVolatility * quote.observedVolatility;
  const costFraction = impactFraction + spreadFraction;
  const executable =
    quote.side === "BUY" ? drifted.mul(1 + costFraction) : drifted.mul(1 - costFraction);
  const executableClamped = executable.isNegative() || executable.isZero() ? new Decimal("0.000000001") : executable;

  // 4. Adverse-selection / MEV draw (against trader, labeled modeled).
  const adverseDraw = rand() * params.maxAdverseDrawFraction;
  const fill =
    quote.side === "BUY"
      ? executableClamped.mul(1 + adverseDraw)
      : executableClamped.mul(1 - adverseDraw);
  const fillClamped = fill.isNegative() || fill.isZero() ? new Decimal("0.000000001") : fill;

  // 5. Fee legs (buy/sell separate). Pool fee is proportional to notional;
  //    ceil keeps it conservative (costs up).
  const poolFeeFraction = quote.verifiedPoolFeeFraction ?? params.defaultPoolFeeFraction;
  const poolFee = BigInt(
    new Decimal(quote.notionalLamports.toString())
      .mul(poolFeeFraction)
      .toDecimalPlaces(0, Decimal.ROUND_CEIL)
      .toString(),
  );
  const buyFeesLamports = quote.side === "BUY" ? poolFee + params.buyFlatFeeLamports : 0n;
  const sellFeesLamports = quote.side === "SELL" ? poolFee + params.sellFlatFeeLamports : 0n;

  // 6. Failure draw AFTER price modeling so vectors stay comparable whether
  //    the attempt succeeds or fails. Failed attempts still incur the flat
  //    network/priority leg where realistic — reported via the fee legs.
  const failDraw = rand();
  let failProb =
    params.baseFailureProbability + params.failurePerVolatility * quote.observedVolatility;
  if (quote.poolLiquidityUsd !== null && quote.poolLiquidityUsd < params.lowLiquidityUsd) {
    failProb += params.lowLiquidityFailureUplift;
  }
  if (failDraw < Math.min(1, Math.max(0, failProb))) {
    return {
      side: quote.side,
      observedPrice: quote.observedPrice,
      executablePrice: executableClamped.toString(),
      fillPrice: fillClamped.toString(),
      fillFraction,
      sampledLatencyMs,
      // Failed attempt: pool fee never accrues; the flat leg may still be
      // spent (modeled). Reported separately from a fill's costs.
      buyFeesLamports: quote.side === "BUY" ? params.buyFlatFeeLamports : 0n,
      sellFeesLamports: quote.side === "SELL" ? params.sellFlatFeeLamports : 0n,
      failure: { ok: false, reason: "simulated-attempt-failed" },
      valuationNote: "modeled: no fill; value portfolio at a fresh mark, never at a modeled price",
    };
  }

  return {
    side: quote.side,
    observedPrice: quote.observedPrice,
    executablePrice: executableClamped.toString(),
    fillPrice: fillClamped.toString(),
    fillFraction,
    sampledLatencyMs,
    buyFeesLamports,
    sellFeesLamports,
    failure: { ok: true },
    valuationNote: "modeled: value portfolio at a fresh mark price, never at fillPrice",
  };
}

function failed(quote: ExecutionQuote, sampledLatencyMs: number, reason: string): ModeledExecution {
  return {
    side: quote.side,
    observedPrice: quote.observedPrice,
    executablePrice: quote.observedPrice,
    fillPrice: quote.observedPrice,
    fillFraction: "0",
    sampledLatencyMs,
    buyFeesLamports: 0n,
    sellFeesLamports: 0n,
    failure: { ok: false, reason },
    valuationNote: "modeled: no fill; value portfolio at a fresh mark, never at a modeled price",
  };
}
