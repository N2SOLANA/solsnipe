import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, MIGRATIONS } from "../src/db/database.js";
import { Ledger } from "../src/ledger/ledger.js";
import { PaperStore } from "../src/trading/paperStore.js";

const START = 10_000_000_000n;
const NOW = 1_791_700_000_000;

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "solsnipe-paper-"));
  const path = join(dir, "app.sqlite");
  return { dir, path, db: openDatabase(path, MIGRATIONS) };
}

function filledLedger() {
  const ledger = new Ledger(START);
  ledger.buyFill({
    token: "MINT_A",
    quantityBaseUnits: 1_000_000n,
    fillPrice: "100",
    feeLamports: 10_000n,
    orderId: "sim-1",
    atMs: NOW,
  });
  return ledger;
}

describe("paper persistence + restart recovery", () => {
  it("persists a fill atomically and recovers it after close/reopen", () => {
    const { dir, path, db } = scratchDb();
    try {
      const store = new PaperStore(db);
      const ledger = filledLedger();
      const snap = ledger.snapshot();
      store.persistFill({
        order: {
          id: "sim-1", idempotencyKey: "k|v|p|BUY|obs:1", side: "BUY",
          state: "FILLED_SIMULATED", notionalLamports: 100_000_000n, createdAtMs: NOW,
          mint: "MINT_A", pairAddress: "PAIR_A",
        },
        transitions: [
          { orderId: "sim-1", from: "PROPOSED", to: "PROPOSED", atMs: NOW, reason: "created" },
          { orderId: "sim-1", from: "PROPOSED", to: "RISK_CHECKED", atMs: NOW, reason: "risk ok" },
        ],
        newLedgerEntries: ledger.journal(),
        ledger,
        cashLamports: snap.cashLamports,
        realizedPnlLamports: snap.realizedPnlLamports,
        cumulativeBuyFeeLamports: snap.cumulativeBuyFeeLamports,
        startLamports: START,
        emergencyStop: false,
        nowMs: NOW,
      });
      expect(store.countOrders()).toBe(1);
      db.close();

      // Simulate restart: reopen and recover.
      const db2 = openDatabase(path, MIGRATIONS);
      const store2 = new PaperStore(db2);
      const rec = store2.recover();
      expect(rec.orders).toHaveLength(1);
      expect(rec.orders[0]?.state).toBe("FILLED_SIMULATED");
      expect(rec.portfolio?.cashLamports).toBe(snap.cashLamports);
      expect(() =>
        store2.verifyRecovery(rec.ledgerEntries, rec.portfolio as NonNullable<typeof rec.portfolio>, rec.positions),
      ).not.toThrow();
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("duplicate idempotency key across restart is a no-op (DB-enforced)", () => {
    const { dir, path, db } = scratchDb();
    try {
      const store = new PaperStore(db);
      const order = {
        id: "sim-1", idempotencyKey: "k|v|p|BUY|obs:1", side: "BUY" as const,
        state: "PROPOSED" as const, notionalLamports: 100_000_000n, createdAtMs: NOW,
        mint: "MINT_A", pairAddress: "PAIR_A",
      };
      expect(store.persistOrderProposed(order)).toBe(true);
      db.close();

      const db2 = openDatabase(path, MIGRATIONS);
      const store2 = new PaperStore(db2);
      expect(store2.persistOrderProposed({ ...order, id: "sim-2" })).toBe(false);
      expect(store2.countOrders()).toBe(1);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tampered journal fails recovery closed", () => {
    const { dir, db } = scratchDb();
    try {
      const store = new PaperStore(db);
      const ledger = filledLedger();
      const snap = ledger.snapshot();
      store.persistFill({
        order: {
          id: "sim-1", idempotencyKey: "k|v|p|BUY|obs:1", side: "BUY",
          state: "FILLED_SIMULATED", notionalLamports: 100_000_000n, createdAtMs: NOW,
          mint: "MINT_A", pairAddress: "PAIR_A",
        },
        transitions: [],
        newLedgerEntries: ledger.journal(),
        ledger,
        cashLamports: snap.cashLamports,
        realizedPnlLamports: snap.realizedPnlLamports,
        cumulativeBuyFeeLamports: snap.cumulativeBuyFeeLamports,
        startLamports: START,
        emergencyStop: false,
        nowMs: NOW,
      });
      const rec = store.recover();
      // Tamper: inflate portfolio cash without journal backing.
      db.prepare("UPDATE sim_portfolio SET cash_lamports = ? WHERE id = 1").run(
        (snap.cashLamports + 1_000_000n).toString(),
      );
      const rec2 = store.recover();
      expect(() =>
        store.verifyRecovery(rec2.ledgerEntries, rec2.portfolio as NonNullable<typeof rec2.portfolio>, rec2.positions),
      ).toThrow(/recovery mismatch/);
      // Untampered recovery still verifies.
      expect(() =>
        store.verifyRecovery(rec.ledgerEntries, rec.portfolio as NonNullable<typeof rec.portfolio>, rec.positions),
      ).not.toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bigint money round-trips losslessly through TEXT columns", () => {
    const { dir, db } = scratchDb();
    try {
      const store = new PaperStore(db);
      const huge = 9_007_199_254_740_993n; // 2^53 + 1: float would corrupt
      store.persistOrderProposed({
        id: "sim-big", idempotencyKey: "big|1|p|BUY|obs:9", side: "BUY",
        state: "PROPOSED", notionalLamports: huge, createdAtMs: NOW,
        mint: "M", pairAddress: "P",
      });
      const rec = store.recover();
      expect(rec.orders[0]?.notionalLamports).toBe(huge);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
