# SOLSNIPE build state — updated every milestone/session
# Full spec: docs/MASTER_PROMPT.md. Rules: CLAUDE.md.

## Current milestone
M1 Foundation — COMPLETE (2026-10-10). `npm run verify` fully green.
Next: M2 Market data + recorder.

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
- `npm run recorder:start` / `recorder:stop` — stubs (refuse until M2 builds it)

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
3. M2: Dexscreener client + recorder, start recorder detached

## Recorder status
Not built yet. Target: start during M2 ASAP.
