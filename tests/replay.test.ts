import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../src/db/snapshots.js";
import { SnapshotStore } from "../src/recorder/store.js";
import { runReplay } from "../src/trading/replay.js";

const START = 10_000_000_000n;

function seedDb(rows: {
  mint: string; pair: string; price: string; liq: string; vol: string; at: number; poll: number;
}[]) {
  const dir = mkdtempSync(join(tmpdir(), "solsnipe-replay-"));
  const db = openDatabase(join(dir, "snap.sqlite"), SNAPSHOT_MIGRATIONS);
  const store = new SnapshotStore(db);
  for (const r of rows) {
    store.writePoll(
      { pollId: r.poll, scheduledDueMs: r.at, actualStartMs: r.at, driftMs: 0, durationMs: 100, slow: false },
      {
        provider: "dexscreener", endpoint: "tokens", statusCode: 200, latencyMs: 100, error: null, rawBody: null,
        observations: [{
          mint: r.mint, pairAddress: r.pair, dexId: "orca", chainId: "solana", quoteMint: "USDC",
          priceUsd: r.price, priceNative: r.price, liquidityUsd: r.liq, liquidityBase: "1000",
          liquidityQuote: "1000", volumeH24: r.vol, volumeH6: r.vol, volumeH1: "1000", volumeM5: "100",
          txnsH24Buys: 500, txnsH24Sells: 500, priceChangeH24: "1.0",
          marketCap: "1000000", fdv: "1000000", pairCreatedAt: r.at - 3_600_000,
          observedAt: r.at, source: "dexscreener:tokens", latencyMs: 100,
          rawHash: `hash-${r.poll}-${r.pair}`, validationNotes: [],
        }],
        dropped: 0,
      },
      1,
      { startupId: "t", intervalMs: 15_000, pairsSeen: 1, consecutiveErrors: 0, watchlistHash: "h", recorderVersion: "t", status: "OK", errorDetail: null },
    );
  }
  return { dir, db };
}

/** A flat price series that ACCEPTs: deep liq, old pair, fresh, no spike. */
function flatSeries(at0: number, n: number, price: string): Parameters<typeof seedDb>[0] {
  return Array.from({ length: n }, (_, i) => ({
    mint: "MINT_R", pair: "PAIR_R", price, liq: "500000", vol: "50000",
    at: at0 + i * 15_000, poll: i + 1,
  }));
}

describe("replay look-ahead canaries (§16.2)", () => {
  it("a future price spike does not change earlier decisions", () => {
    const t0 = 1_791_700_000_000;
    const base = flatSeries(t0, 10, "1.0");
    const { dir: d1, db: db1 } = seedDb(base);
    const r1 = runReplay(db1, { asOfStart: t0, asOfEnd: t0 + 9 * 15_000, strategyId: "baseline", seed: 7 }, START);
    db1.close();
    // Same history + a 10x spike injected at the END.
    const spiked = [...base];
    spiked.push({
      mint: "MINT_R", pair: "PAIR_R", price: "10.0", liq: "500000", vol: "50000",
      at: t0 + 10 * 15_000, poll: 11,
    });
    const { dir: d2, db: db2 } = seedDb(spiked);
    const r2full = runReplay(db2, { asOfStart: t0, asOfEnd: t0 + 10 * 15_000, strategyId: "baseline", seed: 7 }, START);
    // Replay truncated BEFORE the spike must equal the no-spike run exactly.
    const r2trunc = runReplay(db2, { asOfStart: t0, asOfEnd: t0 + 9 * 15_000, strategyId: "baseline", seed: 7 }, START);
    db2.close();
    expect(r2trunc.decisions).toBe(r1.decisions);
    expect(r2trunc.entries).toBe(r1.entries);
    expect(r2trunc.netPnlLamports).toBe(r1.netPnlLamports);
    expect(r2trunc.trades).toEqual(r1.trades);
    expect(r2full.observationsSeen).toBe(r1.observationsSeen + 1);
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  });

  it("as-of bound is enforced: rows after asOfEnd are invisible", () => {
    const t0 = 1_791_700_000_000;
    const { dir, db } = seedDb(flatSeries(t0, 6, "2.0"));
    const narrow = runReplay(db, { asOfStart: t0, asOfEnd: t0 + 2 * 15_000, strategyId: "baseline", seed: 3 }, START);
    const wide = runReplay(db, { asOfStart: t0, asOfEnd: t0 + 5 * 15_000, strategyId: "baseline", seed: 3 }, START);
    db.close();
    expect(narrow.observationsSeen).toBe(3);
    expect(wide.observationsSeen).toBe(6);
    expect(narrow.pollsProcessed).toBeLessThanOrEqual(wide.pollsProcessed);
    rmSync(dir, { recursive: true, force: true });
  });

  it("replay is deterministic for the same inputs", () => {
    const t0 = 1_791_700_000_000;
    const { dir, db } = seedDb(flatSeries(t0, 8, "1.5"));
    const cfg = { asOfStart: t0, asOfEnd: t0 + 7 * 15_000, strategyId: "baseline", seed: 11 };
    const a = runReplay(db, cfg, START);
    const b = runReplay(db, cfg, START);
    db.close();
    expect(b).toEqual(a);
    rmSync(dir, { recursive: true, force: true });
  });

  it("small samples are labeled INCONCLUSIVE, never an edge", () => {
    const t0 = 1_791_700_000_000;
    const { dir, db } = seedDb(flatSeries(t0, 4, "1.0"));
    const r = runReplay(db, { asOfStart: t0, asOfEnd: t0 + 3 * 15_000, strategyId: "baseline", seed: 5 }, START);
    db.close();
    expect(r.verdict).toBe("INCONCLUSIVE — sample too small");
    expect(r.limitations.some((l) => l.includes("pipeline validation"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
