/**
 * Snapshot-store migrations (§9.3, §20). SEPARATE SQLite file from app state
 * to avoid write contention. Tables: observations (normalized), fetch_events
 * (provider status + latency per poll), heartbeats, gaps (explicit outage
 * records — never interpolated). Forward-only.
 */
import type { Migration } from "./database.ts";

export const SNAPSHOT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "snapshots_init",
    sql: `
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        pair_address TEXT NOT NULL,
        dex_id TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        quote_mint TEXT,
        price_usd TEXT,
        price_native TEXT,
        liquidity_usd TEXT,
        liquidity_base TEXT,
        liquidity_quote TEXT,
        volume_h24 TEXT,
        volume_h6 TEXT,
        volume_h1 TEXT,
        volume_m5 TEXT,
        txns_h24_buys INTEGER,
        txns_h24_sells INTEGER,
        price_change_h24 TEXT,
        market_cap TEXT,
        fdv TEXT,
        pair_created_at INTEGER,
        observed_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        raw_hash TEXT NOT NULL,
        validation_notes TEXT NOT NULL DEFAULT '[]',
        poll_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_obs_mint_time ON observations (mint, observed_at);
      CREATE INDEX IF NOT EXISTS idx_obs_pair_time ON observations (pair_address, observed_at);

      CREATE TABLE IF NOT EXISTS fetch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status_code INTEGER,
        latency_ms INTEGER NOT NULL,
        obs_count INTEGER NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS heartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        poll_id INTEGER NOT NULL,
        mints_watched INTEGER NOT NULL,
        obs_written INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gap_start INTEGER NOT NULL,
        gap_end INTEGER NOT NULL,
        expected_polls INTEGER NOT NULL,
        actual_polls INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "snapshots_poll_discipline",
    sql: `
      -- Dedupe + replay support: one row per (poll, mint, pair).
      CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_poll_pair
        ON observations (poll_id, mint, pair_address);
      CREATE INDEX IF NOT EXISTS idx_obs_poll ON observations (poll_id);

      -- Fetch-event timing forensics: slow-vs-missed is unrecoverable without these.
      ALTER TABLE fetch_events ADD COLUMN scheduled_due_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE fetch_events ADD COLUMN drift_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE fetch_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE fetch_events ADD COLUMN slow INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE fetch_events ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE fetch_events ADD COLUMN watchlist_hash TEXT;
      ALTER TABLE fetch_events ADD COLUMN raw_body TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fetch_poll ON fetch_events (poll_id);

      -- Heartbeat expansion: dashboard health summary must be pure SQL.
      ALTER TABLE heartbeats ADD COLUMN startup_id TEXT;
      ALTER TABLE heartbeats ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 15000;
      ALTER TABLE heartbeats ADD COLUMN drift_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN fetch_status INTEGER;
      ALTER TABLE heartbeats ADD COLUMN fetch_latency_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN pairs_seen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN errors INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN status TEXT NOT NULL DEFAULT 'OK'
        CHECK (status IN ('OK','DEGRADED','ERROR','SHUTDOWN'));
      ALTER TABLE heartbeats ADD COLUMN watchlist_hash TEXT;
      ALTER TABLE heartbeats ADD COLUMN recorder_version TEXT;
      ALTER TABLE heartbeats ADD COLUMN db_size_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN obs_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE heartbeats ADD COLUMN error_detail TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_heartbeat_poll ON heartbeats (poll_id);
      CREATE INDEX IF NOT EXISTS idx_heartbeat_ts ON heartbeats (ts);

      -- Gap forensics: replay + dashboard need kind, deltas, and linkage.
      ALTER TABLE gaps ADD COLUMN detail TEXT;
      ALTER TABLE gaps ADD COLUMN kind TEXT NOT NULL DEFAULT 'FULL'
        CHECK (kind IN ('FULL','RESTART','SHUTDOWN'));
      ALTER TABLE gaps ADD COLUMN last_poll_id INTEGER;
      ALTER TABLE gaps ADD COLUMN first_poll_id_after INTEGER;
      ALTER TABLE gaps ADD COLUMN mono_gap_ms INTEGER;
      ALTER TABLE gaps ADD COLUMN wall_gap_ms INTEGER;
      ALTER TABLE gaps ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_gap_window ON gaps (gap_start, gap_end);
    `,
  },
];
