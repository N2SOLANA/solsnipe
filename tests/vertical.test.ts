import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePairs } from "../src/providers/dexscreener.js";
import { scanObservation } from "../src/scanner/scanner.js";
import { runRiskChecks } from "../src/risk/checks.js";
import { evaluateEntry } from "../src/strategy/baseline.js";
import { RiskEngine } from "../src/trading/riskEngine.js";
import { OrderStore, buildIdempotencyKey } from "../src/trading/orders.js";
import { modelExecution, DEFAULT_EXECUTION_PARAMS } from "../src/trading/execution.js";
import { Ledger } from "../src/ledger/ledger.js";
import { EXECUTION_MODE } from "../src/safety/executionMode.js";

/**
 * Vertical slice (§27.1): real fixture data → normalize → scan → risk →
 * strategy → pre-order risk → order lifecycle → modeled execution → ledger →
 * reconcile → duplicate replay idempotent.
 *
 * NOTE: M3 risk entry is BLOCKED by design (six RPC checks NOT_SUPPORTED
 * without on-chain access). This test exercises the FULL wiring with the
 * risk bar explicitly relaxed for the two RPC-unavailable gates — the
 * relaxation is a visible parameter, not a code bypass: meetsEntryBar is
 * never called, and the test asserts the unrelaxed bar still blocks.
 */
const NOW = 1_791_700_000_000;
const START_LAMPORTS = 10_000_000_000n; // 10 SOL

function loadBonkTop() {
  const json = JSON.parse(
    readFileSync(new URL("../fixtures/probes/dexscreener_tokens_BONK.json", import.meta.url), "utf8"),
  );
  const { observations } = parsePairs(json, "dexscreener:tokens", NOW - 5_000, 250);
  const top = [...observations].sort(
    (a, b) => Number(b.liquidityUsd ?? "0") - Number(a.liquidityUsd ?? "0"),
  )[0];
  if (top === undefined) throw new Error("no BONK observations");
  return top;
}

describe("vertical slice: fixture → scan → decide → order → fill → ledger", () => {
  it("runs the full chain with ledger reconciliation and idempotent replay", () => {
    expect(EXECUTION_MODE).toBe("PAPER");

    // 1-3. Real data → normalize → scan.
    const obs = loadBonkTop();
    expect(obs.priceUsd).not.toBeNull();
    const scan = scanObservation(obs, { nowMs: NOW });
    expect(scan.outcome).toBe("ACCEPT");
    expect(scan.explanation.length).toBeGreaterThan(0);

    // 4. Risk checks: unrelaxed bar blocks (documented M3 conservative default).
    const risk = runRiskChecks(obs, NOW);
    expect(risk.entryAllowed).toBe(false);

    // 5. Strategy: ENTRY only when scan ACCEPTs. Feed the decision the risk
    // report with RPC gates relaxed EXPLICITLY (test-only relaxation object).
    const relaxedRisk = { ...risk, entryAllowed: true };
    const decision = evaluateEntry({
      obs,
      scan,
      risk: relaxedRisk,
      modeledCostFraction: "0.02",
      dataAgeMs: 5_000,
    });
    expect(decision.decision).toBe("ENTRY");

    // 6. Pre-order risk engine on the freshest data.
    const engine = new RiskEngine();
    const liqUsd = Number(obs.liquidityUsd ?? "0");
    const notional = (START_LAMPORTS * 4n) / 100n; // 4% of equity
    const key = buildIdempotencyKey({
      strategyId: "baseline",
      strategyVersion: "baseline-v1",
      pair: `${obs.mint}|${obs.pairAddress}`,
      side: "BUY",
      observationId: obs.rawHash,
    });
    const seen = new Set<string>();
    const gate = engine.check({
      nowMs: NOW,
      side: "BUY",
      token: obs.mint,
      notionalLamports: notional,
      availableCashLamports: START_LAMPORTS,
      currentEquityLamports: START_LAMPORTS,
      startOfDayEquityLamports: START_LAMPORTS,
      startOfDayUtcMs: NOW - (NOW % 86_400_000),
      peakEquityLamports: START_LAMPORTS,
      openPositionCount: 0,
      openPositions: [],
      poolLiquidityUsd: liqUsd,
      positionShareOfLiquidity: 0.001,
      modeledEntryCostFraction: 0.02,
      scannerDataAgeMs: 5_000,
      riskDataAgeMs: 5_000,
      consecutiveFailures: 0,
      lastFailureMs: null,
      idempotencyKey: key,
      isDuplicate: (k) => seen.has(k),
      emergencyStop: false,
    });
    expect(gate.allowed).toBe(true);
    seen.add(key);

    // 7-8. Order lifecycle + modeled execution (seeded, deterministic).
    const orders = new OrderStore();
    const order = orders.propose({ side: "BUY", notionalLamports: notional, idempotencyKey: key, nowMs: NOW });
    orders.transition(order.id, "RISK_CHECKED", "risk engine allowed", NOW);
    orders.transition(order.id, "SUBMITTED_SIMULATED", "submitted to paper engine", NOW);
    const exec = modelExecution(
      {
        side: "BUY",
        observedPrice: obs.priceUsd as string,
        executionPrice: obs.priceUsd as string,
        executionPriceAgeMs: 1_000,
        maxExecutionDataAgeMs: 10_000,
        observedVolatility: 0.02,
        poolLiquidityUsd: liqUsd,
        verifiedPoolFeeFraction: null,
        notionalLamports: notional,
      },
      DEFAULT_EXECUTION_PARAMS,
      42, // fixed seed: deterministic mid-distribution sample
    );
    expect(exec.failure.ok).toBe(true);
    if (exec.failure.ok !== true) throw new Error("seeded execution failed unexpectedly");
    orders.transition(order.id, "FILLED_SIMULATED", `filled @ ${exec.fillPrice}`, NOW);

    // Four prices stay distinct in the record.
    expect(exec.observedPrice).toBe(obs.priceUsd);
    expect(typeof exec.executablePrice).toBe("string");
    expect(typeof exec.fillPrice).toBe("string");
    expect(exec.valuationNote.length).toBeGreaterThan(0);

    // 9. Ledger: buy at modeled fill price + fees, then reconcile.
    const ledger = new Ledger(START_LAMPORTS);
    const qty = (notional * 1_000_000_000n) / BigInt(Math.floor(Number(exec.fillPrice) * 1e9));
    expect(qty).toBeGreaterThan(0n);
    ledger.buyFill({
      token: obs.mint,
      quantityBaseUnits: qty,
      fillPrice: exec.fillPrice,
      feeLamports: exec.buyFeesLamports,
      orderId: order.id,
      atMs: NOW,
    });
    const rec = ledger.reconcile({ [obs.mint]: obs.priceUsd as string });
    expect(rec.cash + rec.openValue + ledger.snapshot().cumulativeBuyFeeLamports).toBe(
      START_LAMPORTS + ledger.snapshot().realizedPnlLamports + rec.unrealized,
    );

    // 12. Duplicate replay: same event → same order, no second fill.
    const replay = orders.propose({ side: "BUY", notionalLamports: notional, idempotencyKey: key, nowMs: NOW });
    expect(replay.id).toBe(order.id);
    expect(orders.size).toBe(1);
  });
});
