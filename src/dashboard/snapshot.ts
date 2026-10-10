/**
 * `dashboard:snapshot` entry: read the snapshot DB read-only, render the
 * static dashboard/snapshot.html. Missing/unreadable DB → honest empty page
 * (exit 0, never crash): an absent recorder is a fact to display, not an
 * error to throw.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { SNAPSHOT_MIGRATIONS } from "../db/snapshots.js";
import { runSafetySelfCheck, readOwnDependencyNames } from "../safety/selfCheck.js";
import { DEFAULT_STALE_AFTER_MS, buildDashboard, emptyDashboard } from "./views.js";
import { renderSnapshotHtml } from "./render.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DB_PATH = resolve(root, "data", "snapshots.sqlite");
const OUT_PATH = resolve(root, "dashboard", "snapshot.html");

export function selfCheckStub() {
  return runSafetySelfCheck([], readOwnDependencyNames(resolve(root, "package.json")));
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
        html = renderSnapshotHtml(
          buildDashboard(db, { nowMs, staleAfterMs: DEFAULT_STALE_AFTER_MS, selfCheck }),
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
