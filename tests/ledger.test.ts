/**
 * M4 ledger tests: average-cost P&L, reconcile identity, negative-balance
 * prevention, worked 10%-gross/4%-cost check. PAPER-ONLY, no I/O.
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { Ledger } from "../src/ledger/ledger.js";

const START = 10_000_000_000n; // 10 SOL

describe("ledger", () => {
  it("opens flat and reconciles trivially", () => {
    const L = new Ledger(START);
    const r = L.reconcile({});
    expect(r).toEqual({ cash: START, openValue: 0n, openCost: 0n, unrealized: 0n });
    expect(L.openPositions()).toEqual([]);
  });

  it("buy then full close reconciles; cash path is exact", () => {
    const L = new Ledger(START);
    // Buy 1000 units @ 1_000_000 lamports/unit = 1 SOL, fee 5_000.
    L.buyFill({
      token: "MINT_A",
      quantityBaseUnits: 1000n,
      fillPrice: "1000000",
      feeLamports: 5_000n,
      orderId: "o1",
      atMs: 100,
    });
    expect(L.snapshot().cashLamports).toBe(START - 1_000_000_000n - 5_000n);
    const pos = L.position("MINT_A");
    expect(pos?.quantityBaseUnits).toBe(1000n);
    expect(pos?.averageCost).toBe("1000000");

    // Mark +10%: value 1.1 SOL, unrealized +0.1 SOL.
    const r1 = L.reconcile({ MINT_A: "1100000" });
    expect(r1.unrealized).toBe(100_000_000n);

    // Full close: proceeds floor(1000 * 1.1M) = 1_100_000_000, fee 5_000.
    const close = L.quoteClose("MINT_A", 1000n, 1_100_000_000n, 5_000n);
    expect(close.relievedCostLamports).toBe(1_000_000_000n);
    expect(close.realizedPnlDeltaLamports).toBe(1_100_000_000n - 1_000_000_000n - 5_000n);
    L.sellFill({
      token: "MINT_A",
      quantityBaseUnits: 1000n,
      fillPrice: "1100000",
      proceedsLamports: 1_100_000_000n,
      feeLamports: 5_000n,
      relievedCostLamports: close.relievedCostLamports,
      realizedPnlDeltaLamports: close.realizedPnlDeltaLamports,
      orderId: "o2",
      atMs: 200,
    });
    expect(L.position("MINT_A")).toBeUndefined();
    const r2 = L.reconcile({});
    expect(r2.openValue).toBe(0n);
    // Realized covers proceeds − cost − sell fee; the buy fee is sunk in cash.
    expect(L.snapshot().realizedPnlLamports).toBe(100_000_000n - 5_000n);
    expect(r2.cash).toBe(START + L.snapshot().realizedPnlLamports - 5_000n);
    expect(L.snapshot().cumulativeBuyFeeLamports).toBe(5_000n);
    // Journal is append-only: 2 (buy) + 3 (sell) entries.
    expect(L.entryCount).toBe(5);
  });

  it("worked check: 10% gross rise, 4% round-trip costs -> net follows accounting exactly", () => {
    // Buy 1 SOL of cost basis. Gross +10% => proceeds 1.1 SOL pre-cost.
    // Round-trip modeled costs total 4% of notional (2% each leg incl. fees,
    // impact, MEV draw): net must equal proceeds − cost − fees, exactly.
    const L = new Ledger(START);
    const qty = 1_000_000n;
    const buyPrice = "1000"; // cost = floor(1e6 * 1000) = 1_000_000_000
    L.buyFill({
      token: "MINT_W",
      quantityBaseUnits: qty,
      fillPrice: buyPrice,
      feeLamports: 20_000_000n, // 2% buy leg
      orderId: "w-buy",
      atMs: 10,
    });
    const cost = 1_000_000_000n;
    const grossProceeds = BigInt(
      new Decimal(qty.toString()).mul("1100").toDecimalPlaces(0, Decimal.ROUND_FLOOR).toString(),
    );
    expect(grossProceeds).toBe(1_100_000_000n); // exactly +10% gross
    const sellFee = 20_000_000n; // 2% sell leg; round trip = 4%
    const close = L.quoteClose("MINT_W", qty, grossProceeds, sellFee);
    L.sellFill({
      token: "MINT_W",
      quantityBaseUnits: qty,
      fillPrice: "1100",
      proceedsLamports: grossProceeds,
      feeLamports: sellFee,
      relievedCostLamports: close.relievedCostLamports,
      realizedPnlDeltaLamports: close.realizedPnlDeltaLamports,
      orderId: "w-sell",
      atMs: 20,
    });
    // Net is NOT the gross 10%: the sell leg nets 110M − 20M = +90M over the
    // 1 SOL cost (+9%), while the 20M buy fee is sunk in cash (−2%), so cash
    // ends +70M... precisely: realized = 1.1B − 1B − 20M = +80M; the buy fee
    // sits in cash but not in realized. Round-trip costs total 4% of notional
    // (2% each leg); the point stands: reported net follows the accounting
    // model exactly, not the gross 10%.
    expect(L.snapshot().realizedPnlLamports).toBe(80_000_000n);
    expect(L.snapshot().cashLamports).toBe(START + 80_000_000n - 20_000_000n);
    expect(L.snapshot().cashLamports).toBe(START + 60_000_000n);
    L.reconcile({});
  });

  it("partial close relieves pro-rata average cost and keeps the rest", () => {
    const L = new Ledger(START);
    L.buyFill({
      token: "MINT_P",
      quantityBaseUnits: 1000n,
      fillPrice: "1000000",
      feeLamports: 0n,
      orderId: "p1",
      atMs: 1,
    });
    // Sell half at 2x. Proceeds 1_000_000_000; relieved cost floor(1e9/2).
    const close = L.quoteClose("MINT_P", 500n, 1_000_000_000n, 0n);
    expect(close.relievedCostLamports).toBe(500_000_000n);
    expect(close.realizedPnlDeltaLamports).toBe(500_000_000n);
    L.sellFill({
      token: "MINT_P",
      quantityBaseUnits: 500n,
      fillPrice: "2000000",
      proceedsLamports: 1_000_000_000n,
      feeLamports: 0n,
      relievedCostLamports: close.relievedCostLamports,
      realizedPnlDeltaLamports: close.realizedPnlDeltaLamports,
      orderId: "p2",
      atMs: 2,
    });
    const rest = L.position("MINT_P");
    expect(rest?.quantityBaseUnits).toBe(500n);
    expect(rest?.costBasisLamports).toBe(500_000_000n);
    L.reconcile({ MINT_P: "2000000" });
  });

  it("prevents negative cash and oversell", () => {
    const L = new Ledger(START);
    expect(() =>
      L.buyFill({
        token: "MINT_X",
        quantityBaseUnits: 1_000_000n,
        fillPrice: "100000",
        feeLamports: 0n,
        orderId: "x",
        atMs: 1,
      }),
    ).toThrow(/insufficient simulated cash/);
    L.buyFill({
      token: "MINT_X",
      quantityBaseUnits: 10n,
      fillPrice: "1000000",
      feeLamports: 0n,
      orderId: "x1",
      atMs: 1,
    });
    expect(() =>
      L.sellFill({
        token: "MINT_X",
        quantityBaseUnits: 11n,
        fillPrice: "1000000",
        proceedsLamports: 11_000_000n,
        feeLamports: 0n,
        relievedCostLamports: 11_000_000n,
        realizedPnlDeltaLamports: 0n,
        orderId: "x2",
        atMs: 2,
      }),
    ).toThrow(/insufficient simulated position/);
  });

  it("rejects inconsistent P&L legs instead of inventing profit", () => {
    const L = new Ledger(START);
    L.buyFill({
      token: "MINT_Y",
      quantityBaseUnits: 100n,
      fillPrice: "1000000",
      feeLamports: 0n,
      orderId: "y1",
      atMs: 1,
    });
    // Claimed delta does not equal proceeds − cost − fee.
    expect(() =>
      L.sellFill({
        token: "MINT_Y",
        quantityBaseUnits: 100n,
        fillPrice: "1000000",
        proceedsLamports: 100_000_000n,
        feeLamports: 0n,
        relievedCostLamports: 100_000_000n,
        realizedPnlDeltaLamports: 9_999_999n, // lie
        orderId: "y2",
        atMs: 2,
      }),
    ).toThrow(/proceeds/);
  });

  it("rejects float prices and non-positive fills", () => {
    const L = new Ledger(START);
    for (const bad of ["1e6", "NaN", "-5", "", "1,000"]) {
      expect(() =>
        L.buyFill({
          token: "T",
          quantityBaseUnits: 1n,
          fillPrice: bad,
          feeLamports: 0n,
          orderId: "b",
          atMs: 1,
        }),
      ).toThrow();
    }
    expect(() =>
      L.buyFill({
        token: "T",
        quantityBaseUnits: 0n,
        fillPrice: "1",
        feeLamports: 0n,
        orderId: "b",
        atMs: 1,
      }),
    ).toThrow();
  });

  it("reconcile throws on missing mark", () => {
    const L = new Ledger(START);
    L.buyFill({
      token: "MINT_Z",
      quantityBaseUnits: 5n,
      fillPrice: "1000000",
      feeLamports: 0n,
      orderId: "z",
      atMs: 1,
    });
    expect(() => L.reconcile({})).toThrow(/missing mark/);
  });
});
