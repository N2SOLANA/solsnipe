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

/** Open a DB with WAL + busy timeout and apply pending migrations. */
export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.prepare("PRAGMA journal_mode=WAL").get();
  db.prepare("PRAGMA busy_timeout=5000").get();
  db.prepare("PRAGMA foreign_keys=ON").get();
  migrate(db);
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

export function migrate(db: DatabaseSync): void {
  const current = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      m.version,
      Date.now(),
    );
  }
}
