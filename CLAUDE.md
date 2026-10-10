# CLAUDE.md — Solsnipe hard rules (full spec: `docs/MASTER_PROMPT.md`)

## 1. PAPER-TRADING ONLY (§2 — overrides everything, changeable only via §29)
- Virtual balances/positions/orders exclusively. Never submit, sign, build, or
  serialize real swaps/transactions. Never call swap/transaction-building endpoints.
- Read-only quotes only where §12 allows. No live path via env, flag, toggle, config.
- Never request/store seed phrases, private keys, wallet secrets. No real spending.
- `EXECUTION_MODE = "PAPER" as const` hardcoded; missing/ambiguous mode fails safe.
- No wallet/signing deps. RPC via plain JSON-RPC `fetch` only. New Solana SDK needs user OK.
- Static safety scan (denylist in one file) + network allowlist + runtime guard +
  secret-hygiene tests, all in `npm run verify`.

## 2. Never do (§3.4)
- Never delete/overwrite user files, history, config without approval. Never force-push.
- Never print/log/commit secrets (incl. gateway token). Never claim success w/o evidence.

## 3. Permission gate (§4)
Inspect first; explain need/source/cost/permissions/alternatives; pause for auth;
give safe copy-paste steps; verify after. Ask before: global installs, paid
services, signups, API keys, permission changes outside repo. Never ask for
wallet secrets. Continue independent work while blocked; fixtures labeled.

## 4. Security (§22)
- `.env*` gitignored; `.env.example` placeholders only. Logger redacts secrets.
- Bind `127.0.0.1`. Protect state-changing routes (local token + origin checks).
- Validate all external input; provider data untrusted. No `eval`/unsafe shell.
- Pin deps, commit lockfile, run audit, justify deps in `docs/DECISIONS.md`.
- Gateway may be third-party: assume traffic visible to operator; no wallet secrets.

## 5. Pinned decisions (§5)
TS strict (Node LTS) · SQLite WAL via `node:sqlite` · Vitest + fast-check +
Playwright · dashboard binds 127.0.0.1 · schema validation at boundaries ·
`bigint` lamports/base units + decimal ratios (no float money) · JSON logs redacted.
Unit: SOL (lamports int). Start capital 10 SOL. Conservative rounding (costs up,
proceeds down). Primary data: Dexscreener (`/latest/dex/tokens/{mint}` +
`search`; v1 fallback). v1 scope: graduated/AMM Solana pairs only. Defaults in
spec §5.5 (configurable, validated, not recommendations).

## 6. `npm run verify` = done (§24)
Typecheck + lint + full tests + static safety scan + E2E script: real/labeled
data → normalize → persist → scan → risk → decide → pre-order risk → open →
close → ledger reconciles → restart recovers portfolio → duplicate replay
idempotent → dashboard == DB. Milestone done only when this passes.

## 7. Resumability (§26)
`BUILD_STATUS.md` always: milestone, features, start/stop cmds, arch/key files,
test results, defects, missing creds, Awaiting-user, unfinished, #1 next action,
recorder status. Commit often. Start of session: read it + `git status/log -5` +
check recorder.
