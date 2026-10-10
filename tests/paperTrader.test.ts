import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, MIGRATIONS } from "../src/db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../src/db/snapshots.js";
import { SnapshotStore } from "../src/recorder/store.js";
import { PaperStore } from "../src/trading/paperStore.js";
import { PaperTrader } from "../src/trading/paperTrader.js";

const T0 = 1_791_700_000_000;

function seedSnapshot(db: ReturnType<typeof openDatabase>, n: number, price: string, liq: string) {
  const store = new SnapshotStore(db);
  for (let i = 0; i < n; i++) {
    const at = T0 + i * 15_000;
    store.writePoll(
      { pollId: i + 1, scheduledDueMs: at, actualStartMs: at, driftMs: 0, durationMs: 100, slow: false },
      {
        provider: "dexscreener", endpoint: "tokens", statusCode: 200, latencyMs: 100, error: null, rawBody: null,
        observations: [{
          mint: "MINT_P", pairAddress: "PAIR_P", dexId: "orca", chainId: "solana", quoteMint: "USDC",
          priceUsd: price, priceNative: price, liquidityUsd: liq, liquidityBase: "1000",
          liquidityQuote: "1000", volumeH24: "50000", volumeH6: "50000", volumeH1: "1000", volumeM5: "100",
          txnsH24Buys: 500, txnsH24Sells: 500, priceChangeH24: "1.0",
          marketCap: "1000000", fdv: "1000000", pairCreatedAt: T0 - 3_600_000,
          observedAt: at, source: "dexscreener:tokens", latencyMs: 100,
          rawHash: `hash-${i}`, validationNotes: [],
        }],
        dropped: 0,
      },
      1,
      { startupId: "t", intervalMs: 15_000, pairsSeen: 1, consecutiveErrors: 0, watchlistHash: "h", recorderVersion: "t", status: "OK", errorDetail: null },
    );
  }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "solsnipe-daemon-"));
  const snapDb = openDatabase(join(dir, "snap.sqlite"), SNAPSHOT_MIGRATIONS);
  const appDb = openDatabase(join(dir, "app.sqlite"), MIGRATIONS);
  return { dir, snapDb, appDb, paper: new PaperStore(appDb) };
}

describe("paper-trader daemon", () => {
  it("blocks entries when RPC evidence is missing (fail-closed), auditing each row", () => {
    const { dir, snapDb, appDb, paper } = scratch();
    try {
      seedSnapshot(snapDb, 3, "1.0", "500000");
      const trader = new PaperTrader({ snapshotDb: snapDb, paperStore: paper, nowMs: () => T0 + 100_000 });
      const r = trader.pollOnce();
      expect(r.processed).toBe(3);
      // Scanner ACCEPTs (deep liq, old pair, fresh-ish at seeded times? data
      // age at T0+100s vs observed 0/15/30s → fresh) but risk bar blocks on
      // the six NOT_SUPPORTED checks → BLOCKED_RISK with audit rows.
      expect(r.blockedRisk).toBe(3);
      expect(r.ordersProposed).toBe(0);
      expect(paper.countDaemonEvents()).toBe(3);
      expect(paper.countOrders()).toBe(0);
      // Repeat poll: cursor advanced, nothing reprocessed.
      const r2 = trader.pollOnce();
      expect(r2.processed).toBe(0);
      expect(paper.countDaemonEvents()).toBe(3);
      appDb.close();
      snapDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("duplicate observation replay converges (UNIQUE event guard)", () => {
    const { dir, snapDb, appDb, paper } = scratch();
    try {
      seedSnapshot(snapDb, 1, "1.0", "500000");
      const t1 = new PaperTrader({ snapshotDb: snapDb, paperStore: paper, nowMs: () => T0 + 100_000 });
      expect(t1.pollOnce().processed).toBe(1);
      // New trader instance (simulated restart), same DBs: cursor persisted.
      const t2 = new PaperTrader({ snapshotDb: snapDb, paperStore: paper, nowMs: () => T0 + 200_000 });
      expect(t2.pollOnce().processed).toBe(0);
      expect(paper.countDaemonEvents()).toBe(1);
      appDb.close();
      snapDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BLOCKED_SCAN rows are audited for rejected observations", () => {
    const { dir, snapDb, appDb, paper } = scratch();
    try {
      seedSnapshot(snapDb, 2, "1.0", "10"); // dust liquidity → scanner REJECT
      const trader = new PaperTrader({ snapshotDb: snapDb, paperStore: paper, nowMs: () => T0 + 100_000 });
      const r = trader.pollOnce();
      expect(r.blockedScan).toBe(2);
      expect(paper.countDaemonEvents()).toBe(2);
      appDb.close();
      snapDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("full-PASS evidence proposes exactly one idempotent order", () => {
    const { dir, snapDb, appDb, paper } = scratch();
    try {
      seedSnapshot(snapDb, 2, "1.0", "500000");
      const mintEvidence = new Map([["MINT_P", {
        mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000",
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        fetchedAt: T0, slot: 1,
      }]]);
      const trader = new PaperTrader({
        snapshotDb: snapDb, paperStore: paper, mintEvidence, nowMs: () => T0 + 100_000,
      });
      const r = trader.pollOnce();
      // liquidity+age+mint+freeze+program PASS, but lock/holder/sellability
      // still NOT_SUPPORTED → still blocked. Full PASS needs all eight.
      expect(r.ordersProposed).toBe(0);
      expect(r.blockedRisk).toBe(2);
      appDb.close();
      snapDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
