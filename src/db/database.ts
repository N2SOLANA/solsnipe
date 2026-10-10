/**
 * SQLite via node:sqlite (§5.1): WAL mode, busy timeout, migrations
 * (versioned, forward-only). Recorder uses a separate file (§9.3).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init_health",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS health_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        component TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT
      );
    `,
  },
];

/** Open a DB with WAL + busy timeout and apply the given migrations (forward-only).
 *
 * The migrations argument is REQUIRED (no default): defaulting to the app set
 * once caused the recorder to build the wrong tables into the snapshot file.
 * Call sites must state which database they are opening.
 */
export function openDatabase(path: string, migrations: Migration[]): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.prepare("PRAGMA journal_mode=WAL").get();
  db.prepare("PRAGMA busy_timeout=5000").get();
  db.prepare("PRAGMA foreign_keys=ON").get();
  migrate(db, migrations);
  return db;
}

function currentVersion(db: DatabaseSync): number {
  // schema_version may not exist on a fresh DB — create the table first.
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null };
  return row.v ?? 0;
}

export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  // Guard: versions must be sorted and unique, else a duplicate silently skips.
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1];
    const cur = migrations[i];
    if (prev === undefined || cur === undefined || cur.version <= prev.version) {
      throw new Error(`migrations must be strictly increasing (index ${i})`);
    }
  }
  const current = currentVersion(db);
  for (const m of migrations) {
    if (m.version <= current) continue;
    // Atomic per version: a crash between DDL and version-row leaves either
    // the whole version applied or none (re-runnable on next open).
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        m.version,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back / no transaction — report the original error
      }
      throw err;
    }
  }
}
