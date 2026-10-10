# SOLSNIPE — Solana memecoin intelligence & paper-trading terminal

**PAPER-TRADING ONLY.** Solsnipe uses virtual balances and simulated orders
exclusively. It cannot submit real trades (see `docs/MASTER_PROMPT.md` §2).

## Status
Early build — see `BUILD_STATUS.md` for current milestone and next action.

## Prerequisites
- Node.js LTS (verified on v24.14.1; `node:sqlite` required)
- No API keys needed for v1 (Dexscreener public API, Solana public RPC)
- macOS Apple Silicon primary; Windows support per spec §25 (SQLite driver TBD)

## Install
```sh
npm install
```

## Run
```sh
npm run verify        # typecheck + lint + tests + safety scan + e2e (definition of done)
npm run recorder:start  # detached snapshot recorder (WIP)
npm run recorder:stop
```

## Configuration
Copy `.env.example` to `.env` (names + harmless placeholders only; never commit).
All trading-risk defaults are configurable and documented; starting values in
spec §5.5 are unvalidated starting points, not recommendations.

## Limitations (v1)
- Graduated / AMM-listed Solana pairs only. Bonding-curve pre-migration tokens
  are out of scope (not visible in pair-based APIs until they migrate).
- Dexscreener gives price/liquidity/volume/txns — NOT mint/freeze authority,
  holder concentration, or sellability (those need RPC + quote checks).
- Recorded history starts when YOU start the recorder; replay before that is
  fixtures only. Gaps are disclosed, never filled.
- Simulated state and snapshots are local (gitignored); Git syncs source only.

## Docs
- `docs/MASTER_PROMPT.md` — full spec (verbatim)
- `docs/PROVIDERS.md` — observed provider behavior + fixtures
- `docs/DECISIONS.md` — design decisions (WIP)
- `docs/EXECUTION_MODEL.md` — execution assumptions (WIP)
- `BUILD_STATUS.md` — live build state
