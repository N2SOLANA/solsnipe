/**
 * M4 trading tests: risk engine gates, order state machine, execution model.
 * PAPER-ONLY: no network, no signing, no wallet code paths.
 */
import { describe, expect, it } from "vitest";
import { RiskEngine, DEFAULT_RISK_THRESHOLDS, type RiskCheckInput } from "../src/trading/riskEngine.js";
import {
  OrderStore,
  buildIdempotencyKey,
  isTerminal,
  type OrderState,
} from "../src/trading/orders.js";
import { modelExecution, DEFAULT_EXECUTION_PARAMS, type ExecutionQuote } from "../src/trading/execution.js";

const DAY = 86_400_000;
const NOW = 3 * DAY + 12_000;
const SOD = 3 * DAY; // same UTC day as NOW

function baseInput(over: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    nowMs: NOW,
    side: "BUY",
    token: "MINT_A",
    notionalLamports: 100_000_000n, // 0.1 SOL of 10 SOL = 1%
    availableCashLamports: 10_000_000_000n,
    currentEquityLamports: 10_000_000_000n,
    startOfDayEquityLamports: 10_000_000_000n,
    startOfDayUtcMs: SOD,
    peakEquityLamports: 10_000_000_000n,
    openPositionCount: 0,
    openPositions: [],
    poolLiquidityUsd: 500_000,
    positionShareOfLiquidity: 0.001,
    modeledEntryCostFraction: 0.01,
    scannerDataAgeMs: 5_000,
    riskDataAgeMs: 5_000,
    consecutiveFailures: 0,
    lastFailureMs: null,
    idempotencyKey: "k1",
    isDuplicate: () => false,
    emergencyStop: false,
    ...over,
  };
}

describe("risk engine", () => {
  it("allows a small clean entry", () => {
    const d = new RiskEngine().check(baseInput());
    expect(d).toEqual({ allowed: true, reasons: [] });
  });

  it("rejects invalid thresholds at construction", () => {
    expect(() => new RiskEngine({ maxPositionFraction: 2 })).toThrow();
    expect(() => new RiskEngine({ maxOpenPositions: 0 })).toThrow();
    expect(() => new RiskEngine({ minPoolLiquidityUsd: -1 })).toThrow();
  });

  it("exposes spec 5.5 defaults", () => {
    expect(DEFAULT_RISK_THRESHOLDS.maxPositionFraction).toBe(0.04);
    expect(DEFAULT_RISK_THRESHOLDS.maxTotalExposureFraction).toBe(0.3);
    expect(DEFAULT_RISK_THRESHOLDS.maxOpenPositions).toBe(6);
    expect(DEFAULT_RISK_THRESHOLDS.maxDailyLossFraction).toBe(0.08);
    expect(DEFAULT_RISK_THRESHOLDS.maxDrawdownFraction).toBe(0.2);
    expect(DEFAULT_RISK_THRESHOLDS.minPoolLiquidityUsd).toBe(40_000);
    expect(DEFAULT_RISK_THRESHOLDS.maxPositionShareOfLiquidity).toBe(0.005);
    expect(DEFAULT_RISK_THRESHOLDS.cooldownAfterFailuresMs).toBe(15 * 60_000);
  });

  it("blocks oversized position (4% of 10 SOL = 0.4 SOL)", () => {
    const d = new RiskEngine().check(baseInput({ notionalLamports: 500_000_000n }));
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("max-position-size");
  });

  it("allows exactly-at-limit, blocks a lamport over", () => {
    const limit = 400_000_000n; // exactly 4%
    expect(new RiskEngine().check(baseInput({ notionalLamports: limit })).allowed).toBe(true);
    const over = new RiskEngine().check(baseInput({ notionalLamports: limit + 1n }));
    expect(over.allowed).toBe(false);
    expect(over.reasons).toContain("max-position-size");
  });

  it("blocks per-token exposure breach from existing position", () => {
    const d = new RiskEngine().check(
      baseInput({
        notionalLamports: 100_000_000n,
        openPositions: [{ token: "MINT_A", valueLamports: 350_000_000n }],
      }),
    );
    expect(d.reasons).toContain("max-exposure-per-token");
  });

  it("blocks total exposure breach (30%)", () => {
    const d = new RiskEngine().check(
      baseInput({
        notionalLamports: 100_000_000n,
        openPositions: [{ token: "OTHER", valueLamports: 3_000_000_000n }],
      }),
    );
    expect(d.reasons).toContain("max-total-exposure");
  });

  it("blocks the 7th open position", () => {
    const d = new RiskEngine().check(baseInput({ openPositionCount: 6 }));
    expect(d.reasons).toContain("max-open-positions");
  });

  it("blocks entries past daily loss limit, resets next UTC day", () => {
    const breached = new RiskEngine().check(
      baseInput({ currentEquityLamports: 9_000_000_000n }), // −10% > 8%
    );
    expect(breached.reasons).toContain("daily-loss-limit");
    const nextDay = new RiskEngine().check(
      baseInput({
        nowMs: 4 * DAY + 1_000,
        currentEquityLamports: 9_000_000_000n,
        startOfDayEquityLamports: 9_000_000_000n,
        startOfDayUtcMs: 4 * DAY,
      }),
    );
    expect(nextDay.allowed).toBe(true);
  });

  it("fails closed on a stale start-of-day reference (M5)", () => {
    // Reference two days old: indistinguishable from a stale caller silently
    // disabling the daily-loss limit → must block, even with no loss.
    const stale = new RiskEngine().check(
      baseInput({ nowMs: 4 * DAY + 1_000, startOfDayUtcMs: 2 * DAY }),
    );
    expect(stale.reasons).toContain("stale-start-of-day");
    expect(stale.allowed).toBe(false);
  });

  it("blocks entries past 20% drawdown", () => {
    const d = new RiskEngine().check(baseInput({ currentEquityLamports: 7_900_000_000n }));
    expect(d.reasons).toContain("drawdown-breach");
  });

  it("rejects low / missing liquidity and excessive share", () => {
    expect(
      new RiskEngine().check(baseInput({ poolLiquidityUsd: 10_000 })).reasons,
    ).toContain("low-liquidity");
    expect(
      new RiskEngine().check(baseInput({ poolLiquidityUsd: null })).reasons,
    ).toContain("missing-liquidity");
    expect(
      new RiskEngine().check(baseInput({ positionShareOfLiquidity: 0.01 })).reasons,
    ).toContain("excessive-liquidity-share");
  });

  it("rejects stale / missing data", () => {
    expect(
      new RiskEngine().check(baseInput({ scannerDataAgeMs: 91_000 })).reasons,
    ).toContain("stale-scanner-data");
    expect(new RiskEngine().check(baseInput({ riskDataAgeMs: null })).reasons).toContain(
      "missing-risk-data",
    );
  });

  it("enforces cooldown after 3 consecutive failures for 15 min", () => {
    const inCooldown = new RiskEngine().check(
      baseInput({ consecutiveFailures: 3, lastFailureMs: NOW - 60_000 }),
    );
    expect(inCooldown.reasons).toContain("cooldown");
    const expired = new RiskEngine().check(
      baseInput({ consecutiveFailures: 3, lastFailureMs: NOW - 16 * 60_000 }),
    );
    expect(expired.allowed).toBe(true);
  });

  it("duplicate hook blocks; throwing hook fails closed", () => {
    const dup = new RiskEngine().check(baseInput({ isDuplicate: () => true }));
    expect(dup.reasons).toContain("duplicate-order");
    const throwing = new RiskEngine().check(
      baseInput({
        isDuplicate: () => {
          throw new Error("db down");
        },
      }),
    );
    expect(throwing.allowed).toBe(false);
    expect(throwing.reasons).toContain("duplicate-check-unavailable");
  });

  it("emergency stop blocks entries but allows exits", () => {
    const entry = new RiskEngine().check(baseInput({ emergencyStop: true }));
    expect(entry.allowed).toBe(false);
    expect(entry.reasons).toContain("emergency-stop");
    const exit = new RiskEngine().check(
      baseInput({ emergencyStop: true, side: "SELL", notionalLamports: 50_000_000n }),
    );
    expect(exit).toEqual({ allowed: true, reasons: [] });
  });

  it("rejects excessive modeled entry cost", () => {
    const d = new RiskEngine().check(baseInput({ modeledEntryCostFraction: 0.05 }));
    expect(d.reasons).toContain("excessive-entry-cost");
  });

  it("rejects invalid accounting state", () => {
    expect(new RiskEngine().check(baseInput({ notionalLamports: 0n })).reasons).toContain(
      "invalid-notional",
    );
    expect(
      new RiskEngine().check(baseInput({ notionalLamports: 11_000_000_000n })).reasons,
    ).toContain("insufficient-cash");
  });
});

describe("order state machine", () => {
  it("walks the happy path with timestamps and reasons", () => {
    const store = new OrderStore();
    const o = store.propose({
      side: "BUY",
      notionalLamports: 100_000_000n,
      idempotencyKey: "a|b|c",
      nowMs: 1000,
    });
    expect(o.state).toBe("PROPOSED");
    for (const [to, reason] of [
      ["RISK_CHECKED", "risk pass"],
      ["SUBMITTED_SIMULATED", "sent to simulator"],
      ["FILLED_SIMULATED", "fill reported"],
    ] as [OrderState, string][]) {
      store.transition(o.id, to, reason, 1001);
    }
    expect(store.getOrder(o.id)?.state).toBe("FILLED_SIMULATED");
    expect(isTerminal("FILLED_SIMULATED")).toBe(true);
    expect(store.history(o.id)).toHaveLength(4); // create + 3 transitions
  });

  it("every legal path enumerated; illegal transitions throw", () => {
    const store = new OrderStore();
    const o = store.propose({ side: "BUY", notionalLamports: 1n, idempotencyKey: "x", nowMs: 1 });
    // PROPOSED -> FILLED directly is illegal.
    expect(() => store.transition(o.id, "FILLED_SIMULATED", "skip", 2)).toThrow();
    store.transition(o.id, "RISK_CHECKED", "ok", 2);
    // RISK_CHECKED -> FILLED directly is illegal.
    expect(() => store.transition(o.id, "FILLED_SIMULATED", "skip", 3)).toThrow();
    store.transition(o.id, "SUBMITTED_SIMULATED", "ok", 3);
    store.transition(o.id, "PARTIALLY_FILLED_SIMULATED", "part", 4);
    store.transition(o.id, "PARTIALLY_FILLED_SIMULATED", "more", 5);
    store.transition(o.id, "FILLED_SIMULATED", "done", 6);
    // Terminal states reject everything.
    for (const t of ["RISK_CHECKED", "CANCELLED", "EXPIRED"] as OrderState[]) {
      expect(() => store.transition(o.id, t, "late", 7)).toThrow();
    }
    // Unknown order throws.
    expect(() => store.transition("nope", "CANCELLED", "x", 1)).toThrow();
  });

  it("idempotency key requires a disambiguator and is stable", () => {
    const k1 = buildIdempotencyKey({
      strategyId: "s",
      strategyVersion: "v1",
      pair: "A/B",
      side: "BUY",
      observationId: "obs-1",
    });
    const k2 = buildIdempotencyKey({
      strategyId: "s",
      strategyVersion: "v1",
      pair: "A/B",
      side: "BUY",
      observationId: "obs-1",
    });
    expect(k1).toBe(k2);
    expect(() =>
      buildIdempotencyKey({ strategyId: "s", strategyVersion: "v1", pair: "A/B", side: "BUY" }),
    ).toThrow();
    expect(() =>
      buildIdempotencyKey({
        strategyId: "s",
        strategyVersion: "v1",
        pair: "A/B",
        side: "BUY",
        timeBucketMs: 1000,
      }),
    ).toThrow(); // bucket needs its size
  });

  it("idempotent replay: same event twice = one order", () => {
    const store = new OrderStore();
    const key = buildIdempotencyKey({
      strategyId: "base",
      strategyVersion: "v1",
      pair: "X/Y",
      side: "BUY",
      timeBucketMs: 60_000,
      bucketSizeMs: 60_000,
    });
    const first = store.propose({ side: "BUY", notionalLamports: 5n, idempotencyKey: key, nowMs: 9 });
    const second = store.propose({ side: "BUY", notionalLamports: 5n, idempotencyKey: key, nowMs: 9 });
    expect(second.id).toBe(first.id);
    expect(store.size).toBe(1);
    expect(store.getByIdempotencyKey(key)?.id).toBe(first.id);
  });

  it("rejects invalid proposals", () => {
    const store = new OrderStore();
    expect(() =>
      store.propose({ side: "BUY", notionalLamports: 0n, idempotencyKey: "k", nowMs: 1 }),
    ).toThrow();
    expect(() =>
      store.propose({ side: "BUY", notionalLamports: 1n, idempotencyKey: "", nowMs: 1 }),
    ).toThrow();
  });
});

function quote(over: Partial<ExecutionQuote> = {}): ExecutionQuote {
  return {
    side: "BUY",
    observedPrice: "1.00",
    executionPrice: null,
    executionPriceAgeMs: null,
    maxExecutionDataAgeMs: 10_000,
    observedVolatility: 0.01,
    poolLiquidityUsd: 500_000,
    verifiedPoolFeeFraction: null,
    notionalLamports: 100_000_000n,
    ...over,
  };
}

describe("execution model", () => {
  it("keeps the four prices distinct and deterministic per seed", () => {
    const a = modelExecution(quote(), DEFAULT_EXECUTION_PARAMS, 42);
    const b = modelExecution(quote(), DEFAULT_EXECUTION_PARAMS, 42);
    expect(a).toEqual(b);
    expect(a.sampledLatencyMs).toBeGreaterThanOrEqual(400);
    expect(a.sampledLatencyMs).toBeLessThanOrEqual(3000);
    expect(a.valuationNote).toMatch(/fresh mark/);
    const c = modelExecution(quote(), DEFAULT_EXECUTION_PARAMS, 43);
    expect(c.fillPrice).not.toBe(a.fillPrice);
  });

  it("BUY pays worse than observed; SELL receives worse", () => {
    const calm = { ...DEFAULT_EXECUTION_PARAMS, driftSigmaPerSecond: 0, maxAdverseDrawFraction: 0 };
    const buy = modelExecution(quote({ observedVolatility: 0 }), calm, 7);
    if (buy.failure.ok) {
      expect(Number(buy.fillPrice)).toBeGreaterThan(1);
      expect(buy.buyFeesLamports).toBeGreaterThan(0n);
      expect(buy.sellFeesLamports).toBe(0n);
    }
    const sell = modelExecution(quote({ side: "SELL", observedVolatility: 0 }), calm, 7);
    if (sell.failure.ok) {
      expect(Number(sell.fillPrice)).toBeLessThan(1);
      expect(sell.sellFeesLamports).toBeGreaterThan(0n);
      expect(sell.buyFeesLamports).toBe(0n);
    }
  });

  it("stale execution price fails closed, never fills stale", () => {
    const r = modelExecution(
      quote({ executionPrice: "1.00", executionPriceAgeMs: 30_000 }),
      DEFAULT_EXECUTION_PARAMS,
      1,
    );
    expect(r.failure).toEqual({ ok: false, reason: "stale-execution-price" });
    expect(r.fillFraction).toBe("0");
  });

  it("partial-fills an order that dwarfs the pool", () => {
    const r = modelExecution(
      quote({ poolLiquidityUsd: 50_000, notionalLamports: 10_000_000_000n }),
      { ...DEFAULT_EXECUTION_PARAMS, baseFailureProbability: 0, failurePerVolatility: 0, lowLiquidityFailureUplift: 0 },
      3,
    );
    if (r.failure.ok) expect(Number(r.fillFraction)).toBeLessThan(1);
  });

  it("failure probability rises with volatility (seed sweep)", () => {
    const count = (vol: number): number => {
      let n = 0;
      for (let s = 0; s < 200; s++) {
        const r = modelExecution(quote({ observedVolatility: vol }), DEFAULT_EXECUTION_PARAMS, s);
        if (!r.failure.ok && r.failure.reason === "simulated-attempt-failed") n++;
      }
      return n;
    };
    expect(count(0.5)).toBeGreaterThan(count(0));
  });

  it("rejects bad inputs", () => {
    expect(() => modelExecution(quote({ observedPrice: "abc" }))).toThrow();
    expect(() => modelExecution(quote({ notionalLamports: 0n }))).toThrow();
    expect(() => modelExecution(quote(), { ...DEFAULT_EXECUTION_PARAMS, minLatencyMs: -1 })).toThrow();
  });
});
