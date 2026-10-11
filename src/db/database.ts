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
  {
    version: 2,
    name: "paper_trading",
    sql: `
      -- Simulated orders. idempotency_key UNIQUE is the binding duplicate
      -- guard across restarts (§15.3); the in-memory seen-set is not enough.
      -- Money: lamports/bigint as TEXT (lossless round-trip, no float).
      CREATE TABLE IF NOT EXISTS sim_orders (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
        state TEXT NOT NULL,
        mint TEXT NOT NULL,
        pair_address TEXT NOT NULL,
        notional_lamports TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sim_order_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES sim_orders(id),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_transitions_order
        ON sim_order_transitions (order_id);
      -- Append-only ledger journal (average-cost, §15.2). amount/price as
      -- TEXT: bigint lamports and decimal strings, never REAL.
      CREATE TABLE IF NOT EXISTS sim_ledger_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        price TEXT,
        detail TEXT NOT NULL
      );
      -- Positions snapshot (derived from the journal; rebuilt on restart).
      -- qty/cost as TEXT bigints. One row per token; deleted when flat.
      CREATE TABLE IF NOT EXISTS sim_positions (
        token TEXT PRIMARY KEY,
        qty_base_units TEXT NOT NULL,
        cost_basis_lamports TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Portfolio cash + metadata. Single row (id=1). Cash as TEXT bigint.
      CREATE TABLE IF NOT EXISTS sim_portfolio (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        start_lamports TEXT NOT NULL,
        cash_lamports TEXT NOT NULL,
        realized_pnl_lamports TEXT NOT NULL DEFAULT '0',
        cumulative_buy_fee_lamports TEXT NOT NULL DEFAULT '0',
        emergency_stop INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "paper_trader_daemon",
    sql: `
      -- Durable cursor + audit events for the paper-trader daemon. Cursor and
      -- event insert advance atomically, so repeat polls/restarts are idempotent.
      CREATE TABLE IF NOT EXISTS sim_daemon_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_observation_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO sim_daemon_state (id, last_observation_id, updated_at)
        VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS sim_daemon_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL UNIQUE,
        observed_at INTEGER NOT NULL,
        mint TEXT NOT NULL,
        pair_address TEXT NOT NULL,
        scanner_outcome TEXT NOT NULL,
        risk_allowed INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('BLOCKED_RISK','BLOCKED_SCAN','ORDER_PROPOSED','ERROR')),
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daemon_events_time ON sim_daemon_events (created_at DESC);
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
