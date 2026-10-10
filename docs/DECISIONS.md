# Design decisions (non-trivial only, with date + reason)

## 2026-10-10 — node:sqlite over better-sqlite3
Node v24.14.1 ships `node:sqlite` (`DatabaseSync`); WAL write→read→reopen
cycle tested PASS on arm64 darwin. Zero native-install risk on macOS. Windows
re-verify owed before v1 ships (§25). If it fails there, fall back to
better-sqlite3 (check prebuilt binaries then).

## 2026-10-10 — Dependencies: zod + decimal.js only
- `zod` — schema validation at every external boundary (§5.1 requirement).
- `decimal.js` — ratios/prices; money itself is `bigint` lamports/base units.
- No Solana SDK: RPC is plain JSON-RPC over `fetch` (§2.1 item 2). No wallet
  libs by design (§2). fast-check + Playwright deferred to M5/M7 per plan.
- All versions pinned; lockfile committed.

## 2026-10-10 — Dexscreener endpoint choice
Old `/latest/dex/tokens/{mint}` over `/tokens/v1` — full multi-venue coverage
(30 pairs for BONK vs 1), identical schema. See `docs/PROVIDERS.md`.
