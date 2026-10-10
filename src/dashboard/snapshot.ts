/**
 * `dashboard:snapshot` entry: read the snapshot DB (+ app DB when present),
 * run a replay over the recorded window, render dashboard/snapshot.html.
 * Missing/unreadable DBs → honest empty panels (exit 0, never crash): absent
 * data is a fact to display, not an error to throw.
 *
 * Read discipline: snapshot DB opens via openDatabase (migrations are
 * idempotent and required for schema agreement); app DB presence is optional.
 * Nothing here writes to either database.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, MIGRATIONS } from "../db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../db/snapshots.js";
import { runSafetySelfCheck, readOwnDependencyNames } from "../safety/selfCheck.js";
import { PaperStore } from "../trading/paperStore.js";
import { runReplay } from "../trading/replay.js";
import {
  DEFAULT_STALE_AFTER_MS, buildDashboard, emptyDashboard,
  type PaperState, type ReplaySummary,
} from "./views.js";
import { renderSnapshotHtml } from "./render.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DB_PATH = resolve(root, "data", "snapshots.sqlite");
const APP_DB_PATH = resolve(root, "data", "solsnipe.sqlite");
const OUT_PATH = resolve(root, "dashboard", "snapshot.html");

export function selfCheckStub() {
  return runSafetySelfCheck([], readOwnDependencyNames(resolve(root, "package.json")));
}

function readPaperState(): PaperState | undefined {
  if (!existsSync(APP_DB_PATH)) return undefined;
  try {
    const appDb: DatabaseSync = openDatabase(APP_DB_PATH, MIGRATIONS);
    try {
      const store = new PaperStore(appDb);
      const rec = store.recover();
      if (rec.portfolio === null) return undefined;
      // Marks from the SNAPSHOT db are joined by the caller; here marks are
      // empty (valuation shows cost only). Snapshot-time marks are filled in
      // main() when both DBs are present.
      return {
        startLamports: rec.portfolio.startLamports,
        cashLamports: rec.portfolio.cashLamports,
        realizedPnlLamports: rec.portfolio.realizedPnlLamports,
        emergencyStop: rec.portfolio.emergencyStop,
        positions: rec.positions,
        marks: {},
      };
    } finally {
      appDb.close();
    }
  } catch {
    return undefined; // corrupt/absent app state → honest empty panel
  }
}

export function main(): void {
  const nowMs = Date.now();
  const selfCheck = selfCheckStub();
  let html: string;
  if (!existsSync(DB_PATH)) {
    html = renderSnapshotHtml(
      emptyDashboard(
        "Snapshot database not found (expected at data/snapshots.sqlite) — the recorder has not written any data yet. Start it with: npm run recorder:start",
        nowMs,
        selfCheck,
      ),
    );
  } else {
    try {
      const db: DatabaseSync = openDatabase(DB_PATH, SNAPSHOT_MIGRATIONS);
      try {
        // Replay over the full recorded window (bounded: read-only SELECTs;
        // 10k rows replay in milliseconds). Verdict carries its own honesty label.
        const range = db.prepare(
          "SELECT MIN(observed_at) AS a, MAX(observed_at) AS b FROM observations",
        ).get() as { a: number | null; b: number | null };
        let replay: ReplaySummary | undefined;
        let marks: Record<string, string> = {};
        if (range.a !== null && range.b !== null) {
          const report = runReplay(
            db,
            { asOfStart: range.a, asOfEnd: range.b, strategyId: "baseline", seed: 42 },
            10_000_000_000n,
          );
          replay = {
            trades: report.trades.length,
            netPnlLamports: report.netPnlLamports,
            verdict: report.verdict,
            windowStart: report.windowStart,
            windowEnd: report.windowEnd,
          };
          const latest = db.prepare(
            `SELECT mint, price_usd FROM observations WHERE (mint, observed_at) IN (
               SELECT mint, MAX(observed_at) FROM observations GROUP BY mint
             ) AND price_usd IS NOT NULL`,
          ).all() as { mint: string; price_usd: string }[];
          for (const r of latest) marks[r.mint] = r.price_usd;
        }
        const paper = readPaperState();
        if (paper !== undefined) paper.marks = marks;
        html = renderSnapshotHtml(
          buildDashboard(db, {
            nowMs,
            staleAfterMs: DEFAULT_STALE_AFTER_MS,
            selfCheck,
            paper,
            replay,
          }),
        );
      } finally {
        db.close();
      }
    } catch (err) {
      html = renderSnapshotHtml(
        emptyDashboard(
          `Snapshot database unreadable (${err instanceof Error ? err.message : String(err)}) — showing an honest empty page instead of stale numbers.`,
          nowMs,
          selfCheck,
        ),
      );
    }
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, html, "utf8");
  console.log(`dashboard snapshot written to ${OUT_PATH}`);
}

// Run only when invoked directly (importable by tests without side effects).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
