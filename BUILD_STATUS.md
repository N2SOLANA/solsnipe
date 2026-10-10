# SOLSNIPE build state — updated every milestone/session
# Full spec: docs/MASTER_PROMPT.md. Rules: CLAUDE.md.

## Current milestone
M3 Scanner + risk + M4 paper trading + dashboard scaffold — COMPLETE
(2026-10-11). `npm run verify` fully green (85/85). Recorder RUNNING.
Next: on-chain RPC evidence, M6 backtest replay, M7 dashboard completion.

## Implemented
- Probe: Dexscreener search + tokens endpoints, Solana RPC health, Jupiter Lite
  quote — all live, fixtures in `fixtures/probes/`, findings in `docs/PROVIDERS.md`.
- node:sqlite WAL write→read→reopen test: PASS.
- Rate limits empirical: 40 search @~5/s + 80 tokens/v1 back-to-back, zero 429s.
- Endpoint choice: old `/latest/dex/tokens/{mint}` (full venue coverage, 30
  pairs for BONK) over `/tokens/v1` (1 pair/mint). Same schema.
- Docs: `docs/MASTER_PROMPT.md` (spec verbatim), `docs/PROVIDERS.md`,
  `docs/DECISIONS.md`, `CLAUDE.md`, `README.md`, `.env.example`,
  `.gitattributes`, `.claude/settings.json` (deny .env reads + force-push).
- Safety core: `EXECUTION_MODE="PAPER" as const`, denylist + exemptions (one
  shared scan rule), allowlisted `allowedFetch`, redacting JSON logger,
  validated zod config, migrations + WAL DB, startup self-check.
- `npm run verify` = typecheck + lint + build + tests + safety-scan + e2e skeleton.
- M2 (this run): Dexscreener provider (`src/providers/dexscreener.ts`, 518
  lines: zod-normalized observations, RetryableError classification, deadline +
  conservatively-rounded Decimals) + recorder (`src/recorder/`: anchored
  setTimeout loop, gap rows, one-txn-per-poll store, SHUTDOWN heartbeat) +
  snapshot migrations (`src/db/snapshots.ts`) + watchlist
  (`config/watchlist.json`: WSOL/BONK/WIF/TRUMP) + hardened lifecycle script
  (atomic O_EXCL pidfile, ps identity). 13 recorder tests.
- Deps pinned (zod, decimal.js; @types/node, TS, vitest dev), lockfile committed,
  `npm audit`: 0 vulnerabilities.

## Implemented
- Probe: Dexscreener search + tokens endpoints, Solana RPC health, Jupiter Lite
  quote — all live, fixtures in `fixtures/probes/`, findings in `docs/PROVIDERS.md`.
- node:sqlite WAL write→read→reopen test: PASS.
- Rate limits empirical: 40 search @~5/s + 80 tokens/v1 back-to-back, zero 429s.
- Endpoint choice: old `/latest/dex/tokens/{mint}` (full venue coverage, 30
  pairs for BONK) over `/tokens/v1` (1 pair/mint). Same schema.
- Docs: `docs/MASTER_PROMPT.md` (spec verbatim), `docs/PROVIDERS.md`,
  `CLAUDE.md`, `README.md`.

## Startup / stop commands
- `npm run verify` — typecheck + lint + build + vitest + safety-scan + e2e ✅ green
- `npm run recorder:start` / `recorder:stop` / `recorder:status` — hardened
  lifecycle (atomic pidfile, identity check); start pending step 4 of this run

## Architecture & key files
- `src/safety/executionMode.ts` — `EXECUTION_MODE = "PAPER"` (TBD M1)
- `src/net/httpClient.ts` — allowlisted outbound HTTP (TBD M1)
- `src/safety/denylist.ts` — static-scan denylist (TBD M1)
- `src/db/` — migrations + WAL setup (TBD M1)
- `src/providers/dexscreener.ts` — client (TBD M2)
- `src/recorder/` — detached snapshot recorder (TBD M2)

## Tests executed (actual results)
- node:sqlite WAL cycle: PASS (2026-10-10, Node v24.14.1 arm64)
- Provider probes: all 200 except one transient Jupiter 503 (retried OK)
- `npm run verify` (2026-10-10): GREEN — typecheck clean, lint clean,
  build clean, 16/16 tests pass (safety 11, db/scan-sync 5),
  safety-scan clean (5 deps), e2e skeleton PASS (self-check + migrate smoke)
- `npm run verify` (2026-10-10, M2 run): GREEN — typecheck clean, lint clean
  (17 files), build clean, 32/32 tests pass (safety 11, db 8, recorder 13),
  safety-scan clean (18 files, 5 deps), e2e PASS (self-check + migrate smoke)
- `npm audit`: 0 vulnerabilities

## Known defects
- None yet (no app code).

## Missing deps / creds
- None for M1–M2. No keys, no paid services, no installs needed.

## Awaiting user
- Nothing. (Windows `node:sqlite` re-verify owed before v1 ships — §25.)

## Unfinished / next
1. `.env.example`, `.gitattributes`, `.claude/settings.json`
2. Scaffold: package.json, tsconfig strict, vitest, safety files, db, verify skeleton
3. M2: commit + start recorder detached, confirm rows growing (this run, step 4)

## Recorder status
RUNNING since 2026-10-10 20:28 UTC (pid 26882, detached, logs/recorder.log).
3750+ observations, 125+ heartbeats, 0 gaps (verified 2026-10-11 ~04:00 UTC,
30 rows/20s growth, heartbeat age 2.8s). Watchlist: WSOL/BONK/WIF/TRUMP.
DB: data/snapshots.sqlite (gitignored runtime artifact).
M3/M4 additions this run: scanner (rules+scanner, 6 tests), risk checks
(8 checks, 5 tests), BaselineV1 strategy, risk engine + orders + execution +
ledger (36 tests), EXECUTION_MODEL.md, dashboard views/render/snapshot
(5 tests), vertical slice test (fixture→scan→decide→order→fill→ledger→
reconcile→idempotent replay, PASS), dashboard:snapshot script rendering
live DB to dashboard/snapshot.html with PAPER badge.
Verify 2026-10-11: 85/85 tests (9 files), safety-scan clean (29 files),
e2e PASS. NOTE: e2e.mjs is still the M1 skeleton (self-check + migrate
smoke) — the vertical slice lives in tests/vertical.test.ts, not in e2e.
