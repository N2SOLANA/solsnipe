/**
 * Dashboard M7 tests: view-models equal DB state (temp snapshot DB seeded via
 * SnapshotStore), empty states explicit, snapshot.html regenerates with PAPER
 * + real seeded numbers. No network; no float money.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../src/db/snapshots.js";
import { SnapshotStore } from "../src/recorder/store.js";
import {
  buildDashboard,
  buildPortfolioView,
  buildPerformanceView,
  emptyDashboard,
  DEFAULT_STALE_AFTER_MS,
} from "../src/dashboard/views.js";
import { renderSnapshotHtml } from "../src/dashboard/render.js";
import type { SelfCheckResult } from "../src/safety/selfCheck.js";

const SELF_CHECK: SelfCheckResult = {
  ok: true,
  mode: "PAPER",
  checks: [{ name: "execution-mode", ok: true, detail: "EXECUTION_MODE=PAPER" }],
};

const OBS = {
  mint: "So11111111111111111111111111111111111111112",
  pairAddress: "PAIR11111111111111111111111111111111111111",
  dexId: "raydium",
  chainId: "solana",
  quoteMint: "Es9vMFrzaCERi6hdJ8xHxzhqRjqNzU1y1tfNdfbTvz" as string | null,
  priceUsd: "0.000123",
  priceNative: "0.000001",
  liquidityUsd: "123456.78",
  liquidityBase: null as string | null,
  liquidityQuote: null as string | null,
  volumeH24: "98765.43",
  volumeH6: null as string | null,
  volumeH1: null as string | null,
  volumeM5: null as string | null,
  txnsH24Buys: 100,
  txnsH24Sells: 90,
  priceChangeH24: "2.5",
  marketCap: null as string | null,
  fdv: null as string | null,
  pairCreatedAt: 1_700_000_000_000 - 3_600_000,
  observedAt: 1_700_000_000_000,
  source: "test-seed",
  latencyMs: 250,
  rawHash: "a".repeat(64),
  validationNotes: [] as string[],
};

function seedDb(): { dir: string; db: DatabaseSync; store: SnapshotStore } {
  const dir = mkdtempSync(join(tmpdir(), "solsnipe-dash-"));
  const db = openDatabase(join(dir, "snap.sqlite"), SNAPSHOT_MIGRATIONS);
  const store = new SnapshotStore(db);
  const timing = {
    pollId: 7,
    scheduledDueMs: 1_700_000_000_000,
    actualStartMs: 1_700_000_000_010,
    driftMs: 10,
    durationMs: 300,
    slow: false,
  };
  const result = {
    provider: "dexscreener",
    endpoint: "tokens",
    statusCode: 200 as number | null,
    latencyMs: 250,
    error: null as string | null,
    rawBody: null,
    observations: [OBS],
    dropped: 0,
  };
  const hb = {
    startupId: "test",
    intervalMs: 15_000,
    pairsSeen: 1,
    consecutiveErrors: 0,
    watchlistHash: "h",
    recorderVersion: "test",
    status: "OK" as const,
    errorDetail: null,
  };
  store.writePoll(timing, result, 1, hb);
  store.recordGap({
    gapStart: 1_699_999_000_000,
    gapEnd: 1_699_999_060_000,
    expectedPolls: 4,
    reason: "NETWORK_ERROR",
    detail: "seeded test gap",
  });
  return { dir, db, store };
}

describe("dashboard view-models equal DB state", () => {
  it("scanner row matches seeded observation; health matches counts/gaps", () => {
    const { dir, db } = seedDb();
    try {
      const nowMs = 1_700_000_000_000 + 10_000; // 10s later → fresh
      const view = buildDashboard(db, {
        nowMs,
        staleAfterMs: DEFAULT_STALE_AFTER_MS,
        selfCheck: SELF_CHECK,
      });
      // Scanner: exact decimal strings from seed, freshness from real age.
      expect(view.scanner.rows).toHaveLength(1);
      const row = view.scanner.rows[0];
      expect(row).toBeDefined();
      expect(row?.mint).toBe(OBS.mint);
      expect(row?.priceUsd).toBe("0.000123");
      expect(row?.liquidityUsd).toBe("123456.78");
      expect(row?.volumeH24).toBe("98765.43");
      expect(row?.freshness).toBe("FRESH");
      expect(row?.ageMs).toBe(10_000);
      expect(view.scanner.totalPairs).toBe(1);
      expect(view.scanner.empty).toBe(false);
      expect(view.scanner.sources).toContain("test-seed");
      // Health: PAPER mode, real counts, disclosed gap, recorder status.
      expect(view.health.executionMode).toBe("PAPER");
      expect(view.health.selfCheck).toBe(SELF_CHECK);
      expect(view.health.counts.observations).toBe(1);
      expect(view.health.counts.gaps).toBe(1);
      expect(view.health.gaps).toHaveLength(1);
      expect(view.health.gaps[0]?.reason).toBe("NETWORK_ERROR");
      expect(view.health.providers).toHaveLength(1);
      expect(view.health.providers[0]?.provider).toBe("dexscreener");
      // Activity: one fetch event + one heartbeat from the seed poll.
      expect(view.activity.fetchEvents).toHaveLength(1);
      expect(view.activity.fetchEvents[0]?.pollId).toBe(7);
      expect(view.activity.heartbeats).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stale data is labeled STALE, not presented as current", () => {
    const { dir, db } = seedDb();
    try {
      // SnapshotStore timestamps heartbeats at write time; pin this fixture's
      // recorder timestamp to the observation clock for deterministic staleness.
      db.prepare("UPDATE heartbeats SET ts = ?").run(1_700_000_000_000);
      const view = buildDashboard(db, {
        nowMs: 1_700_000_000_000 + 10 * 60_000, // 10 min later
        staleAfterMs: DEFAULT_STALE_AFTER_MS,
        selfCheck: SELF_CHECK,
      });
      expect(view.scanner.rows[0]?.freshness).toBe("STALE");
      expect(view.health.dataStale).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("portfolio/performance are explicit empty states, not zeros", () => {
    const portfolio = buildPortfolioView();
    expect(portfolio.empty).toBe(true);
    expect(portfolio.reason).toContain("no fills persisted");
    expect(portfolio.cashLamports).toBeNull();
    expect(portfolio.openPositions).toEqual([]);
    const performance = buildPerformanceView();
    expect(performance.empty).toBe(true);
    expect(performance.reason).toContain("fabricated");
    expect(performance.trades).toBe(0);
    const { dir, db } = seedDb();
    try {
      const view = buildDashboard(db, {
        nowMs: 1_700_000_000_000 + 10_000,
        staleAfterMs: DEFAULT_STALE_AFTER_MS,
        selfCheck: SELF_CHECK,
      });
      expect(view.portfolio.empty).toBe(true);
      expect(view.performance.empty).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emptyDashboard is honest about a missing DB", () => {
    const view = emptyDashboard("test missing reason", 1_700_000_000_000, SELF_CHECK);
    expect(view.scanner.empty).toBe(true);
    expect(view.scanner.reason).toContain("test missing reason");
    expect(view.health.executionMode).toBe("PAPER");
    expect(view.health.dataStale).toBe(true);
    expect(view.portfolio.empty).toBe(true);
  });

  it("snapshot.html regenerates with PAPER badge + real seeded numbers", () => {
    const { dir, db } = seedDb();
    try {
      const view = buildDashboard(db, {
        nowMs: 1_700_000_000_000 + 10_000,
        staleAfterMs: DEFAULT_STALE_AFTER_MS,
        selfCheck: SELF_CHECK,
      });
      const html = renderSnapshotHtml(view);
      const out = join(dir, "snapshot.html");
      mkdirSync(dir, { recursive: true });
      writeFileSync(out, html, "utf8");
      const read = readFileSync(out, "utf8");
      expect(read).toContain("PAPER");
      expect(read).toContain("0.000123"); // real seeded price
      expect(read).toContain("123456.78"); // real seeded liquidity
      expect(read).toContain("NETWORK_ERROR"); // disclosed gap
      expect(read).toContain("no fills persisted"); // portfolio empty state
      expect(read).not.toContain("http://");
      expect(read).not.toContain("https://");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
