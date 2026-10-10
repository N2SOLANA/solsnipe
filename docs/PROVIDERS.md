# Provider observations (probed 2026-10-10, all live, no keys)

Fixtures: `fixtures/probes/`. All responses saved raw; field lists below were
verified against the fixtures, not copied from docs.

## 1. Dexscreener — primary market data

Base: `https://api.dexscreener.com`. No auth. No `RateLimit-*` response headers.

| Endpoint | Fixture | Observed |
|---|---|---|
| `GET /latest/dex/search?q=SOL` | `dexscreener_search_SOL.json` | 200 in 0.24s; 30 pairs, 16 `chainId:"solana"` |
| `GET /latest/dex/tokens/{mint}` (BONK) | `dexscreener_tokens_BONK.json` | 200; **30 pairs** (all venues: orca 11, meteora 12, raydium 7) |
| `GET /latest/dex/tokens/{mint}` (WSOL) | `dexscreener_tokens_WSOL.json` | 200; pairs returned |
| `GET /tokens/v1/solana/{mints}` (BONK,WSOL) | `dexscreener_tokens_v1_BONK_WSOL.json` | 200; **1 pair per mint** (top venue only) |
| `GET /token-pairs/v1/solana/{mint}` (BONK) | `dexscreener_tokenpairs_v1_BONK.json` | 200; 30 pairs (same coverage as old endpoint) |

Pair object fields (identical schema on old and v1 endpoints — verified by key
comparison): `chainId, dexId, url, pairAddress, labels, baseToken{address,name,
symbol}, quoteToken{...}, priceNative, priceUsd, txns{m5,h1,h6,h24:{buys,sells}},
volume{h24,h6,h1,m5}, priceChange{m5,h1,h6,h24}, liquidity{usd,base,quote},
fdv, marketCap, pairCreatedAt (ms epoch), info{imageUrl, websites[], socials[]}`.

Sample (BONK/orca): priceUsd `0.000003408`, liquidity.usd `368698.83`,
volume.h24 `209711.42`, pairCreatedAt `1671980424000`.

### Quirks
- Unknown mint returns **200 with `"pairs": null`** (not 404, not `[]`).
  Client must treat `null` as "no data". (We initially misread this as an
  indexer gap — it was our own wrong mint string, off by 2 chars. Lesson:
  always cross-check a mint via `search` before concluding the API lacks it.
  Correct: BONK `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`,
  TRUMP `6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN`.)
- v1 endpoints return bare arrays (`[]` when empty); old endpoint returns
  `{"schemaVersion","pairs"}` envelope (`null` when empty).
- `liquidity.base/quote` semantics on CLMM/DLMM pools are unverified —
  do NOT feed them into the price-impact model without validation.
- `fdv`/`marketCap` methodology is undocumented; record with provenance,
  never derive supply from them.

### Rate limits (empirical, 2026-10-10)
- Burst 1: 40 search requests @ ~5/s → 40×200, no 429 (~237 ok/min pace).
- Burst 2: 80 `tokens/v1` requests back-to-back → 80×200 in 2.5s, no 429.
- Documented-but-unverified web claims say 300/min (pairs/tokens) and
  60/min (profiles/boosts). Observed behavior is more permissive, but the
  recorder will still poll conservatively (≥15s interval, backoff on 429).
  Stopped probing deliberately to avoid tripping abuse detection.

### What Dexscreener does NOT give us
Mint/freeze authority, token program / extensions, holder concentration,
liquidity-lock status, sellability. Those need Solana RPC (§12.1–12.3) and a
read-only quote endpoint.

### Client choice
Use the **old `/latest/dex/tokens/{mint}`** endpoint for per-token snapshots
(full multi-venue coverage, same schema, same 200/`null` contract) and
`/latest/dex/search` for discovery. Keep v1 behind the provider interface as
a fallback. Revisit only if Dexscreener deprecates the old paths.

## 2. Solana public RPC — on-chain checks only

`POST https://api.mainnet-beta.solana.com`, `getHealth` → 200 in 1.26s,
`{"result":"ok"}` (fixture `solana_rpc_getHealth.json`). Plain JSON-RPC over
`fetch` suffices; no SDK needed. Rate-limited — heavy polling stays on
Dexscreener; RPC is for infrequent mint-account reads. No provider account
needed unless 429s appear in Milestone 3.

## 3. Jupiter Lite quote — sellability evidence (candidate, unverified docs)

`GET https://lite-api.jup.ag/swap/v1/quote?...amount=1000000&slippageBps=50`
→ 200 in ~1.05s, no key (fixture `jupiter_lite_quote_SOL_USDC.json`).
Returns `outAmount`, `priceImpactPct`, `routePlan[{swapInfo{label,...}}]`,
`contextSlot`, `swapUsdValue`. 0.001 SOL→USDC quoted `110370` via `Invariant`.
**One transient 503 observed** (nginx page, retry 5s later succeeded) — the
client must handle non-JSON/5xx as `UNKNOWN`, never as failure-to-sell.
Docs confirmation of quote-only, no-cost access still owed before wiring in.
Swap/transaction-building endpoints are out of scope (§2) and denylisted.

## 4. node:sqlite check (2026-10-10, Node v24.14.1, arm64 darwin)

`node:sqlite` (`DatabaseSync`) present. WAL mode enables cleanly,
`busy_timeout` settable, write→read→close→reopen cycle returns all rows
(`SQLITE WAL TEST: PASS`). Decision: use `node:sqlite`, no `better-sqlite3`.
Re-verify on Windows per §25 before v1 ships.
