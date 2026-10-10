import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parsePairs, normalizePair, cleanMintList, chunkMints, stableStringify } from "../src/providers/dexscreener.js";
import { NormalizedObservationSchema } from "../src/providers/types.js";
import { openDatabase } from "../src/db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../src/db/snapshots.js";
import { SnapshotStore } from "../src/recorder/store.js";
import { loadWatchlist } from "../src/recorder/watchlist.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/probes/${name}`, import.meta.url), "utf8"));
}

function scratchDb(): { dir: string; db: DatabaseSync; store: SnapshotStore } {
  const dir = mkdtempSync(join(tmpdir(), "solsnipe-rec-"));
  const db = openDatabase(join(dir, "snap.sqlite"), SNAPSHOT_MIGRATIONS);
  return { dir, db, store: new SnapshotStore(db) };
}

describe("provider normalization (offline fixtures)", () => {
  it("parses the real BONK response: all pairs survive, schema-valid", () => {
    const { observations, dropped } = parsePairs(fixture("dexscreener_tokens_BONK.json"), "dexscreener:tokens", 1_700_000_000_000, 250);
    expect(dropped).toEqual([]);
    expect(observations.length).toBeGreaterThan(5);
    for (const o of observations) {
      expect(() => NormalizedObservationSchema.parse(o)).not.toThrow();
      expect(o.chainId).toBe("solana");
    }
  });

  it("unknown mint (pairs:null) yields zero obs, no error", () => {
    const { observations, dropped } = parsePairs({ schemaVersion: "1.0.0", pairs: null }, "dexscreener:tokens", 1, 1);
    expect(observations).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("one malformed pair does not sink the poll", () => {
    const good = (fixture("dexscreener_tokens_WSOL.json") as { pairs: unknown[] }).pairs[0];
    const { observations, dropped } = parsePairs(
      { pairs: [good, { nope: true }, { ...good, pairAddress: (good as { pairAddress: string }).pairAddress }] },
      "t", 1, 1,
    );
    expect(observations).toHaveLength(1); // third is an in-poll duplicate
    expect(dropped).toHaveLength(2);
  });

  it("malformed decimals are nulled with notes (missing != zero)", () => {
    const good = JSON.parse(JSON.stringify((fixture("dexscreener_tokens_WSOL.json") as { pairs: unknown[] }).pairs[0]));
    good.priceUsd = "0x10";
    good.liquidity = { usd: -5, base: 1.5 };
    good.volume = { h24: Number.NaN };
    const { observation, dropped } = normalizePair(good, "t", 1_700_000_000_000, 1);
    expect(dropped).toBeNull();
    expect(observation.priceUsd).toBeNull();
    expect(observation.liquidityUsd).toBeNull();
    expect(observation.volumeH24).toBeNull();
    expect(observation.validationNotes.length).toBeGreaterThanOrEqual(3);
    // ...but the observation itself still validates (nulls are legal).
    expect(() => NormalizedObservationSchema.parse(observation)).not.toThrow();
  });

  it("priceChangeH24 allows negatives, rejects NaN strings", () => {
    const good = JSON.parse(JSON.stringify((fixture("dexscreener_tokens_WSOL.json") as { pairs: unknown[] }).pairs[0]));
    good.priceChange = { h24: -2.5 };
    const a = normalizePair(good, "t", 1_700_000_000_000, 1);
    expect(a.dropped).toBeNull();
    expect(a.observation.priceChangeH24).toBe("-2.5");
    good.priceChange = { h24: Number.NaN };
    const b = normalizePair(good, "t", 1_700_000_000_000, 1);
    expect(b.dropped).toBeNull(); // nulled, not dropped
    expect(b.observation.priceChangeH24).toBeNull();
    expect(b.observation.validationNotes.some((n: string) => n.includes("priceChange"))).toBe(true);
  });

  it("implausible pairCreatedAt is nulled with a note", () => {
    const good = JSON.parse(JSON.stringify((fixture("dexscreener_tokens_WSOL.json") as { pairs: unknown[] }).pairs[0]));
    good.pairCreatedAt = 1_700_000_000; // seconds, not ms
    const { observation, dropped } = normalizePair(good, "t", 1_700_000_000_000, 1);
    expect(dropped).toBeNull();
    expect(observation.pairCreatedAt).toBeNull();
    expect(observation.validationNotes.some((n: string) => n.includes("pairCreatedAt"))).toBe(true);
  });

  it("rawHash is stable under key reorder", () => {
    const a = { x: 1, y: [1, 2], z: { p: "a", q: "b" } };
    const b = { z: { q: "b", p: "a" }, y: [1, 2], x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("cleanMintList validates, dedupes; chunkMints chunks at 30", () => {
    const mints = ["So11111111111111111111111111111111111111112", " So11111111111111111111111111111111111111112 ", ""];
    expect(cleanMintList(mints)).toEqual(["So11111111111111111111111111111111111111112"]);
    expect(() => cleanMintList(["not-a-mint"])).toThrow();
    expect(() => cleanMintList(["   "])).toThrow(); // empty after validation
    const big = Array.from({ length: 65 }, (_, i) => `1${"A".repeat(31)}${String(i).padStart(2, "0")}`.slice(0, 44));
    expect(chunkMints(big).map((c) => c.length)).toEqual([30, 30, 5]);
  });
});

describe("snapshot store", () => {
  it("writes a poll atomically and replays idempotently", () => {
    const { dir, db, store } = scratchDb();
    try {
      const { observations } = parsePairs(fixture("dexscreener_tokens_BONK.json"), "dexscreener:tokens", 1_700_000_000_000, 250);
      const timing = { pollId: 1, scheduledDueMs: 1000, actualStartMs: 1010, driftMs: 10, durationMs: 300, slow: false };
      const result = { provider: "dexscreener", endpoint: "tokens", statusCode: 200 as number | null, latencyMs: 300, error: null as string | null, rawBody: null, observations, dropped: 0 };
      const hb = { startupId: "abc", intervalMs: 15_000, pairsSeen: observations.length, consecutiveErrors: 0, watchlistHash: "h", recorderVersion: "t", status: "OK" as const, errorDetail: null };
      const first = store.writePoll(timing, result, 1, hb);
      expect(first.inserted).toBe(observations.length);
      const second = store.writePoll(timing, result, 1, hb); // duplicate replay
      expect(second.inserted).toBe(0);
      const health = store.getHealth();
      expect(health.observations).toBe(observations.length);
      expect(health.heartbeats).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records explicit gaps and restart gaps, never interpolates", () => {
    const { dir, db, store } = scratchDb();
    try {
      store.recordGap({ gapStart: 1000, gapEnd: 46000, expectedPolls: 3, reason: "NETWORK_ERROR", detail: "fetch failed" });
      const gaps = db.prepare("SELECT * FROM gaps").all() as { reason: string; actual_polls: number }[];
      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.reason).toBe("NETWORK_ERROR");
      expect(gaps[0]?.actual_polls).toBe(0);
      // Restart gap: stale heartbeat → one RESTART gap row.
      db.prepare("INSERT INTO heartbeats (ts, poll_id, mints_watched, obs_written) VALUES (1000, 1, 1, 5)").run();
      expect(store.recordRestartGap(1000 + 60_000, 15_000)).toBe(true);
      expect(store.recordRestartGap(1000 + 60_000, 15_000)).toBe(false); // still stale, but gap_end must advance — writes again only if newer
      const all = db.prepare("SELECT reason, kind FROM gaps ORDER BY id").all() as { reason: string; kind: string }[];
      expect(all[1]?.kind).toBe("RESTART");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fresh heartbeat is not a restart gap", () => {
    const { dir, db, store } = scratchDb();
    try {
      db.prepare("INSERT INTO heartbeats (ts, poll_id, mints_watched, obs_written) VALUES (1000, 1, 1, 5)").run();
      expect(store.recordRestartGap(1000 + 5_000, 15_000)).toBe(false);
      expect(store.getHealth().gaps).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("watchlist", () => {
  it("loads the shipped watchlist", () => {
    const wl = loadWatchlist(new URL("../config/watchlist.json", import.meta.url).pathname);
    expect(wl.mints.length).toBeGreaterThanOrEqual(4);
    expect(wl.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects invalid mints and empty lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "solsnipe-wl-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify([{ mint: "nope" }]));
      expect(() => loadWatchlist(bad)).toThrow();
      const empty = join(dir, "empty.json");
      writeFileSync(empty, JSON.stringify([{ mint: "So11111111111111111111111111111111111111112", active: false }]));
      expect(() => loadWatchlist(empty)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
