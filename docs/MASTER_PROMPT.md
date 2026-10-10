# SOLSNIPE — MASTER BUILD PROMPT
## Autonomous Solana Memecoin Intelligence & Paper-Trading Terminal

You are the lead software architect, senior full-stack engineer, quantitative trading systems engineer, security engineer, data engineer, product designer, and technical project manager responsible for building **Solsnipe**.

Your mission is to build a real, testable, maintainable Solana memecoin intelligence and paper-trading application. Do not merely create a prototype that looks functional. Prioritize real data, correct calculations, explainable decisions, realistic execution simulation, security, and verified functionality.

Operate autonomously on routine development tasks. Ask me for input only when a decision, credential, installation, permission, paid service, or other authorization genuinely requires my involvement.

The time window is limited (about 24 hours of wall-clock time, with the key expiring at the end of it, so plan to finish by about hour 19) and I am often away from the keyboard. The token allowance is large (roughly 10 million tokens), so tokens are not the scarce resource; wall-clock time and correctness are. Do not waste time on idle exploration, repeated plans, or decorative work. Spend tokens generously on verification, review, and testing. Preserve progress continuously, and never sacrifice correctness to claim completion.

---

# 0. HOW TO USE THIS DOCUMENT

This document is the full specification. It is long, so do the following immediately, before anything else:

1. Save this entire document verbatim to `docs/MASTER_PROMPT.md` in the repository, so any future or restarted session can re-read it.
2. Write a short `CLAUDE.md` (target: under 150 lines) containing only the hard rules (Sections 2, 3.4, 4, 22), the pinned decisions (Section 5), the `npm run verify` definition (Section 24), the resumability protocol (Section 26), and a pointer to `docs/MASTER_PROMPT.md` for everything else. `CLAUDE.md` is loaded into every session, so keep it tight.
3. Read sections of `docs/MASTER_PROMPT.md` on demand as you reach each milestone, rather than keeping everything in context.

If this document and a later instruction from me conflict, my later instruction wins, **except** for Section 2 (the paper-trading boundary), which can only be changed by the explicit, separate approval process in Section 29.

---

# 1. PROJECT MISSION

Build Solsnipe as a personal Solana memecoin research, market-monitoring, strategy-evaluation, and paper-trading terminal.

The system should ultimately:

- Discover newly created and existing Solana token markets.
- Monitor prices, liquidity, trading volume, volatility, and market activity.
- Assess token and liquidity risks using verifiable on-chain evidence.
- Identify potential opportunities and reject dangerous or low-quality candidates.
- Combine deterministic quantitative analysis with selective AI-assisted research.
- Generate explainable BUY, SELL, HOLD, and REJECT decisions.
- Simulate orders, entries, exits, fees, slippage, execution delays, and failures.
- Track a persistent virtual portfolio and trade history.
- Evaluate strategies using historical replay of recorded data and paper-trading results.
- Display live data, simulated activity, risk assessments, and performance in a sophisticated terminal interface.
- Run independently of Claude Code once installed and configured.
- Support future development without compromising the initial release's security boundaries.

The initial objective is to determine whether a strategy performs credibly under realistic assumptions, **not** to guarantee profits.

**Success means demonstrated functionality and honest measurement, not a large feature count or an attractive dashboard.** An honest "this strategy loses money after costs" is a successful result. A dashboard showing fabricated or flattering numbers is a failure.

---

# 2. NON-NEGOTIABLE PAPER-TRADING BOUNDARY

The initial release is strictly **PAPER-TRADING-ONLY**. This rule overrides every other instruction, including later instructions from me unless they follow Section 29.

During the initial release:

- Use real market data whenever verified access is available.
- Use virtual balances, virtual positions, and simulated orders exclusively.
- Never submit real swaps or live trading transactions.
- Never sign live transactions or transfer SOL or tokens.
- Never build, serialize, or request real swap transactions from any service (for example, never call a "swap" or "build transaction" endpoint of an aggregator). Read-only quote requests are permitted only where Section 12 allows them.
- Never implement an enabled live-order submission path.
- Never activate live execution through an environment variable, UI toggle, configuration change, CLI flag, or fallback.
- Never request or store my wallet seed phrase, private key, wallet password, or other wallet secrets.
- Never spend real funds on trades, transactions, subscriptions, or infrastructure without my explicit approval.
- Preserve paper-trading mode after restarts.
- If execution mode is missing, ambiguous, or invalid, fail safely and block execution.

A successful simulated trade is not a real blockchain transaction. Paper-trading success does not authorize live trading.

## 2.1 Mechanical enforcement (required, not optional)

Instructions alone are not a safety mechanism. Implement and test all of the following:

1. **Hardcoded execution mode.** The execution mode is a constant in code (for example `EXECUTION_MODE = "PAPER" as const`), not read from environment or config. There is no code path that branches into a non-paper mode.
2. **No wallet or signing dependencies.** Do not install wallet adapters, keypair utilities, or transaction-signing libraries in the initial release. Read-only Solana RPC access is done with plain JSON-RPC over `fetch`. If you believe a Solana SDK package is genuinely required, ask me first (Section 4).
3. **Static safety test.** An automated test (part of `npm run verify`) scans source files and the dependency manifest and fails if it finds signing or sending primitives or wallet libraries (for example `Keypair`, `signTransaction`, `signAllTransactions`, `sendTransaction`, `sendRawTransaction`, `sendAndConfirmTransaction`, wallet-adapter packages, seed-phrase or mnemonic handling), or any HTTP call to known swap or transaction-building endpoints. Maintain the denylist in one file with comments explaining each entry.
4. **Network allowlist.** Outbound HTTP goes through one client module that only permits hosts listed in a config allowlist. A test verifies that unlisted hosts are rejected.
5. **Runtime guard.** The paper execution engine is the only module allowed to create fills, and it refuses to operate if the safety self-check (Section 2.1 items 1–4) fails at startup. Startup logs the active mode and the result of the self-check.
6. **Secret hygiene tests.** Tests confirm `.env` and key material are gitignored and that the logger redacts known secret patterns.

The initial release must be demonstrably incapable of submitting real trades through its normal application workflow. Do not build a hidden or dormant live-execution pathway as a shortcut, even disabled.

---

# 3. SESSION CONSTRAINTS AND UNATTENDED OPERATION

## 3.1 Budget and time
- Roughly 24 hours wall-clock. Roughly 10M tokens. Treat time as the scarce resource.
- Spend tokens on: independent review passes, property-based tests, failure injection, careful reading of provider documentation, screenshot-based UI verification.
- Do not spend tokens on: feature sprawl, speculative abstractions, repeated re-planning, or polishing before the core works.

## 3.2 I am often away
- Work autonomously. Do not stop to ask about trivial choices; pick a sensible documented default and continue.
- Stop only for: credentials, paid services, global installs, permission changes, destructive or irreversible operations, force-push or history rewrites, or a genuine ambiguity that affects safety.
- When blocked on something that needs me, record it in `BUILD_STATUS.md` under "Awaiting user", continue with independent work, and make the blocker easy to resolve when I return (exact steps, exact commands).
- Prefer non-interactive commands. Never run a blocking process (dev server, watcher, recorder) in the foreground of your own terminal session. Run long-lived processes detached, with logs written to `./logs/` and PID files, and provide `start` and `stop` scripts.
- Put timeouts on every command that could hang (network calls, installs, test runs).

## 3.3 Interruptions: network loss, sleep, restarts
My laptop may sleep, move, or lose internet. Design for it:
- On any session start or resume, first read `BUILD_STATUS.md`, `git status`, and `git log -5`, then continue from the recorded next step. Do not redo completed work.
- If network calls fail, retry with bounded exponential backoff. If still failing, switch to offline-capable work (tests, accounting, UI, docs) and note the outage in `BUILD_STATUS.md`. Do not mark a feature failed because of a transient outage, and do not fabricate data to bridge it.
- The market-snapshot recorder (Section 9.3) must run as an independent detached process that survives your session ending, writes durable data, and records its own heartbeat so outages appear as **disclosed gaps**, never as interpolated or filled data.
- Commit after every meaningful working step so an interruption loses at most a small amount of work.

## 3.4 Never do these
- Never delete or overwrite my existing files, repository history, or configuration without approval.
- Never force-push or rewrite Git history.
- Never print, log, or commit secrets, including the coding-gateway token.
- Never claim success without evidence (command output, test results, or a screenshot you actually inspected).

---

# 4. INSTALLATION, AUTHENTICATION, AND PERMISSION GATE

Inspect the development environment, repository, installed software, configuration structure, and permissions before assuming anything is missing.

Whenever a task requires software installation, account authentication, API access, credentials, additional permissions, license acceptance, system configuration changes, or a paid service, follow this procedure.

**Step 1: Inspect.** Determine whether the dependency, package, service, or configuration already exists. Do not reinstall working dependencies. Do not overwrite existing configuration blindly. Inspect environment variable names without printing values.

**Step 2: Explain what is needed.** Before an action requiring my participation, state: (1) the exact dependency, service, account, credential, or permission; (2) why it is necessary and which feature depends on it; (3) where to obtain it, preferably from official documentation; (4) whether it costs money, including known quotas and recurring costs; (5) the minimum permissions required and security implications; (6) free or cheaper alternatives; (7) the exact next step I must take. Do not invent endpoints, prices, quotas, authentication requirements, or capabilities. Label unverified details as unverified.

**Step 3: Pause for authorization.** Stop before the action that requires my involvement. Do not purchase subscriptions, incur charges, grant unnecessary permissions, accept significant contractual terms, or deploy paid infrastructure without explicit approval.

**Step 4: Give safe instructions.** Provide copy-paste-ready commands and explain any that delete files, overwrite configuration, modify security settings, expose services, or are irreversible. Never ask me to paste passwords, seed phrases, private keys, or wallet secrets into chat.

**Step 5: Verify.** After I complete setup, verify the dependency actually works before relying on it. If verification fails, report the exact error, separate confirmed facts from assumptions, and recommend the next safe diagnostic step. Never claim an integration succeeded without evidence.

**Step 6: Continue independent work** while waiting. Use fixtures only when clearly labeled. Never present mock data as live data.

Specifically ask before: global package installs, any paid service, any account signup, any API key, any permission or settings change outside the project directory.

---

# 5. PINNED DECISIONS AND DEFAULTS

These are decided so you do not burn time re-deciding them. Change one only with a documented technical reason in `BUILD_STATUS.md`.

## 5.1 Stack
- **Language:** TypeScript (strict mode), Node.js LTS.
- **Database:** SQLite in WAL mode with a migrations system. Prefer Node's built-in SQLite if the installed Node version supports it stably; otherwise `better-sqlite3`. Verify the chosen driver installs cleanly on **both Apple Silicon macOS and Windows** (check prebuilt binary availability) before committing to it.
- **Test runner:** Vitest. **Property-based testing:** fast-check. **E2E/UI verification:** Playwright.
- **Dashboard:** Next.js (App Router) or a lighter React setup if inspection shows a concrete reason. Server-sent events for live updates. Bind to `127.0.0.1` only.
- **Validation:** a schema library (for example Zod) at every external boundary.
- **Numerics:** `bigint` for lamports and token base units; a decimal library for ratios and prices. **No floating-point arithmetic for balances, positions, fills, fees, or P&L.**
- **Logging:** structured JSON logs with secret redaction.

## 5.2 Money and units
- **Unit of account: SOL** (lamports as integers). Provider prices are often USD-denominated; convert using a SOL/USD observation that carries its own timestamp and provenance, and flag conversions that use a stale rate.
- **Starting virtual capital: 10 SOL.**
- **Rounding:** documented, deterministic, and conservative (round against the trader: costs up, proceeds down). Tests cover rounding.

## 5.3 First data source
- **Primary market data: Dexscreener public API.** Read the official documentation to verify the actual endpoints, response fields, and current rate limits before writing the client. To my knowledge it exposes pair-level price, liquidity, volume, transaction counts, and pair-creation time, and it applies per-endpoint rate limits; **verify all of this rather than trusting this sentence.** It does **not** provide mint authority, freeze authority, holder concentration, or sellability; those require Section 12 sources.
- **On-chain checks:** Solana JSON-RPC (read-only). The public mainnet endpoint is rate-limited and unsuitable for heavy use; if an RPC provider account is needed, follow Section 4 and propose free-tier options with verified quotas.
- **Sellability / exit-quote checks:** read-only quote endpoint of a major aggregator, only if its documentation confirms quote-only access without credentials or cost. Otherwise mark sellability `NOT_SUPPORTED` and document it. Never call swap or transaction-building endpoints.

## 5.4 Scope for v1
- **Graduated / AMM-listed pairs only** (pairs that have a DEX pool and appear in the market-data provider). Bonding-curve tokens that have not yet migrated are **out of scope for v1**; document this limitation honestly in the README and dashboard (many brand-new launches are not visible in pair-based APIs until they migrate).
- Single chain: Solana.

## 5.5 Conservative initial risk defaults
All values are configurable, documented, validated, and **unvalidated starting points, not recommendations**.

| Control | Initial default |
|---|---|
| Starting capital | 10 SOL |
| Max position size | 4% of current equity |
| Max exposure per token | 4% of current equity |
| Max total exposure | 30% of equity |
| Max open positions | 6 |
| Max daily simulated loss | 8% of start-of-UTC-day equity; blocks new entries until next UTC day |
| Max drawdown from peak | 20%; triggers emergency stop (manual reset required) |
| Max modeled entry slippage + price impact | 4% |
| Max modeled exit price impact (at current position size) | 6% |
| Min pool liquidity | USD 40,000 equivalent |
| Max position as share of pool liquidity | 0.5% |
| Max data age: scanner / risk check / execution time | 90 s / 30 s / 10 s |
| Min pair age before eligibility | 30 minutes (configurable; documents why) |
| Cooldown after 3 consecutive failed simulated orders | 15 minutes |

---

# 6. FIRST ACTION: INSPECT THE ENVIRONMENT

Begin by inspecting; do not generate the application yet. Determine:

- Operating system and architecture; current working directory.
- Existing repository files and `git status`. If existing work is present, preserve it. If empty, initialize cleanly.
- Installed Node.js, package manager, Git, Python, and relevant tooling, with versions.
- Whether the Node version supports the intended SQLite approach.
- Existing configuration structure (names only, never values).
- Which integrations are already configured and which need credentials, installation, or approval.

Then: (1) write a concise implementation plan in `BUILD_STATUS.md`; (2) list blockers per Section 4; (3) execute Section 0 steps; (4) establish project structure; (5) begin Milestone 1.

Do not stop after producing the plan. Proceed.

---

# 7. DOCUMENTATION AND REPOSITORY HYGIENE

Create and maintain:

- `README.md` — installation, configuration, operation, troubleshooting, limitations (including the v1 scope limits in 5.4).
- `CLAUDE.md` — short, rules-only (Section 0).
- `docs/MASTER_PROMPT.md` — this document verbatim.
- `docs/DECISIONS.md` — each non-trivial design decision with the reason and date.
- `docs/EXECUTION_MODEL.md` — every execution assumption, its default, and why it is modeled rather than verified.
- `BUILD_STATUS.md` — current milestone, completed work, startup commands, architecture and key files, tests executed with actual results, known defects, awaiting-user items, next action.
- `.env.example` — variable names with harmless placeholders only.
- `.gitignore` — excludes `.env*`, databases, logs, snapshots, build output, and sensitive material.
- `.gitattributes` — normalizes line endings for macOS and Windows.

Git practices:
- Inspect `git status` before significant changes. Commit coherent, working milestones with clear messages. Commit small and often.
- Never commit secrets, API keys, tokens, databases, or sensitive logs. Scan staged changes for secret patterns before each commit (add a pre-commit check).
- Never force-push or rewrite history.

Claude Code project settings: create `.claude/settings.json` with deny rules for reading `.env*` files and for force-push, and keep permission allowances minimal and project-local. Describe what you configured in `BUILD_STATUS.md`.

---

# 8. MILESTONES AND TIME PLAN

Follow this order unless a verified technical dependency requires a justified adjustment. **Each milestone ends with a gate: run `npm run verify`, inspect the diff, update `BUILD_STATUS.md`, commit. If the gate passes, continue to the next milestone without waiting for me. If it fails, fix it before moving on.**

| Milestone | Target hours | Content |
|---|---|---|
| 1. Foundation | 0–2 | Project structure, strict TS, lint, tests, config validation, redacted logging, DB + migrations, hardcoded paper mode, safety guard tests, docs skeleton, `npm run verify` skeleton |
| 2. Market data + recorder | 2–4 | Provider interface, Dexscreener client, normalization/validation, freshness, provider health, rate-limit-aware polling, **snapshot recorder running as a detached process (start it as early as possible and leave it running)** |
| 3. Scanner + risk checks | 4–7 | Deterministic scanner (ACCEPT/REJECT/REVIEW), on-chain risk checks (PASS/FAIL/UNKNOWN/NOT_SUPPORTED), baseline strategy, explainable decisions |
| 4. Paper trading | 7–11 | Risk engine, order state machine, ledger, execution model, positions/P&L, dedupe, restart recovery |
| 5. Adversarial verification | 11–13 | Independent review passes, property-based tests, failure injection, security review |
| 6. Backtest replay | 13–15 | Chronological replay on recorded data, baselines, honest reporting |
| 7. Dashboard | 15–18 | Functional panels first, then visual identity, Playwright screenshot verification |
| 8. Handoff | 18–19 | Full verify run, docs accuracy, final commit, exact run commands |

**Speed rules.** My coding-API key expires about 24 hours after the session starts, so everything must be finished, verified, and committed by roughly **hour 19**, leaving the remaining hours as buffer. The speedup comes from tighter time boxes and parallel work, never from skipping verification.
- Time-box every milestone. If one runs 50% over its target, ship the minimal working version, record the gap in `BUILD_STATUS.md`, and move on.
- Use parallel subagents for independent work (for example dashboard scaffolding alongside engine work, or test writing alongside implementation) where the interfaces are already defined.
- Do not wait on me for routine approvals. Batch all questions for me into one `Awaiting user` list.
- Do the final `npm run verify` run, the restart-recovery test, and the handoff by hour 19. Do not leave them for the last hour.
- After the key expires, the recorder and the application must keep working without Claude Code.

Hours are a planning guide. If something slips, protect this priority order:
1. Real data ingestion (or a documented, isolated access blocker) and the recorder.
2. Validation and risk checks.
3. Simulated order lifecycle.
4. Correct fees, balances, positions, and P&L.
5. Persistence and restart recovery.
6. End-to-end verification.
7. Minimal usable dashboard.
8. Optional features and visual polish.

A smaller working system is better than a large unfinished one. Do not skip core milestones to add features. Do not begin AI research (Section 17) or social intelligence (Section 18) until Milestone 6 passes.

---

# 9. MARKET-DATA ARCHITECTURE

## 9.1 Provider abstraction
Build a modular provider interface so sources can be replaced without rewriting the scanner, strategy, risk engine, paper execution, or dashboard. Start with one market-data source and add a Solana RPC client only for the on-chain checks in Section 12. Do not assume a provider exposes every field.

## 9.2 Normalize and validate
Where supported, record: chain identifier; token mint address; pair/pool identifier; DEX; base and quote assets; price and observation timestamp; liquidity (with currency); volume over available intervals; buy/sell transaction counts where provided; market cap or FDV with source and methodology; pair age when verifiable; data-source provenance and freshness; evidence-backed risk indicators.

- Distinguish **missing** from **zero**. Use explicit nullable types, not defaults.
- Reject malformed, non-finite, negative, or implausible values, and record why.
- Do not infer circulating supply, holder concentration, mint/freeze authority, or liquidity-lock status from fields that do not establish them.
- Record the raw provider payload (or a hash and reference) alongside the normalized record for audit and schema-change debugging.

## 9.3 Snapshot recorder (high priority)
Free market-data APIs generally do not provide deep historical order-level data. **Your realistic replay dataset is whatever Solsnipe records itself.** Therefore:

- Build the recorder in Milestone 2 and start it immediately.
- It runs as a **separate detached process** (`npm run recorder:start` / `recorder:stop`), independent of the dashboard and of your session.
- Use a **separate SQLite file** for snapshots to avoid write contention with application state (or document why not). WAL mode, busy timeout, batched inserts.
- Record, per poll: normalized observations, provider response status and latency, and a heartbeat row.
- Detect and log **gaps** (missed polls, outages, sleep). Gaps are stored as explicit gap records. Never interpolate, forward-fill, or fabricate observations.
- Make polling set size, interval, and retention configurable and rate-limit-aware.
- Include a recorder health summary (rows, time coverage, gap count, last write) for the dashboard.

## 9.4 Reliability
Handle stale and missing data, malformed responses, rate limits and quota exhaustion, timeouts, network failures, duplicate events, provider outages, schema changes, and conflicting observations. Use bounded retries, sensible timeouts, caching, and backoff. Avoid uncontrolled polling. When sources disagree, record provenance and apply a documented resolution policy. Never fabricate live market activity to conceal a provider failure.

## 9.5 Price provenance
Every observation used for a decision carries timestamp, source identifier, freshness status, and validation results. "Real-time" depends on the provider and transport; do not imply zero latency without measurement. Measure and display actual provider latency and observation age.

---

# 10. TOKEN DISCOVERY AND SCANNER

Build a deterministic, configurable scanner over newly discovered and existing Solana pairs.

Screening conditions (all thresholds configurable and documented): minimum liquidity; minimum recent trading activity; estimated spread or execution cost when measurable; data freshness and quality; pair age; abnormal price movements; volume-to-liquidity relationships; suspicious or inconsistent market data; verifiable token authorities and extensions; holder concentration where reliable evidence exists; deployer activity where reliable evidence exists; potential sell restrictions or other significant indicators.

Outcomes:
- `ACCEPT` — passes configured initial screening requirements.
- `REJECT` — fails a required screening condition.
- `REVIEW` — evidence is incomplete or requires investigation.

Record reasons, supporting evidence, and data freshness for every outcome. Do not assume high volume, a rising price, or popularity implies safety. Do not label a token malicious on one unverified signal. **The scanner identifies candidates; it does not authorize execution.**

---

# 11. SCANNER OUTPUT CONTRACT

Each scanner result is a structured, persisted record: candidate id (mint + pair), timestamp, outcome, per-rule results (rule id, pass/fail/unknown, observed value, threshold, source, observation time), data-freshness status, and a human-readable explanation. The same record feeds the dashboard and the audit log, so there is one source of truth.

---

# 12. ON-CHAIN RISK VERIFICATION

Use only properties that can be verified through available, authorized data sources. A market-data API cannot provide all of these; investigate what the Solana RPC and permitted quote endpoints actually support, and verify against documentation.

## 12.1 Token configuration
- Mint authority status and freeze authority status (read the mint account).
- Token program (classic Token vs Token-2022) and Token-2022 extensions: transfer fees, transfer hooks, permanent delegate, non-transferable, default account state, confidential transfers, and any other extension affecting transfers or trading.
- Policy: a Token-2022 extension that can restrict, tax, or seize transfers is a `FAIL` for entry unless the execution model explicitly models it and the policy permits it.

## 12.2 Liquidity and market structure
- Pool liquidity and depth; pool age where available.
- Liquidity-control information. A liquidity lock is `PASS` only if verifiable from evidence, with the scope and limits of that evidence stated. Otherwise `UNKNOWN` or `NOT_SUPPORTED`.
- Price-impact estimate at the proposed simulated order size.
- Concentrated or shallow liquidity.

## 12.3 Ownership and activity
- Holder concentration. Note limits: the RPC's largest-accounts call returns a limited set of **token accounts**, not owners, and may include pool vaults, burn addresses, and system accounts. Handle those appropriately and state the limitation in the evidence.
- Deployer activity and related-wallet behavior only where reliable evidence exists.
- Suspicious transaction patterns and evidence of possible sell restrictions.
- Sellability: only through a permitted read-only quote or simulation method. A successful quote is evidence of a route, not a guarantee of an executable sale.

## 12.4 Recording and statuses
For each check record: check id, status, source, observation timestamp, supporting evidence, limitations and reason for uncertainty. Allowed statuses: `PASS`, `FAIL`, `UNKNOWN`, `NOT_SUPPORTED`.

**`UNKNOWN` and `NOT_SUPPORTED` are never treated as `PASS`.** A missing field is not proof of safety. A risk score is a screening aid, not a guarantee. **Hard safety rules operate independently of aggregate scores.** Do not claim a token is safe, that liquidity is permanently locked, that ownership is adequately distributed, or that selling is possible unless the evidence supports that specific claim. If critical evidence is missing, apply the configured conservative policy (default: do not enter) and explain the limitation.

---

# 13. STRATEGY ENGINE

Implement a replaceable, explainable strategy interface. The strategy consumes validated market data, scanner results, and risk constraints and returns a structured decision containing: candidate id; decision timestamp; BUY / SELL / HOLD / REJECT; supporting metrics; entry conditions; exit conditions; risk and invalidation conditions; proposed position size; estimated execution costs; reasons for inaction; strategy version and configuration; data freshness and quality status.

## 13.1 Baseline strategy (BaselineV1)
Implement a deliberately simple, transparent baseline so the pipeline can be exercised and measured. It is **not** claimed to be profitable.

- **Entry candidates:** scanner `ACCEPT`, all required risk checks `PASS`, and an entry rule such as: liquidity and volume-to-liquidity within configured bands, positive short-window momentum without an extreme recent spike (avoid chasing), and acceptable modeled costs.
- **Exits:** configurable stop-loss, take-profit, trailing stop, and time stop; plus forced exit on risk-check `FAIL` appearing, liquidity collapse, or stale-data conditions per policy.
- **Sizing:** fixed fraction of equity capped by the risk engine and by position-to-liquidity limits.
- All parameters are configurable and versioned. Record the version with every decision.

Do not optimize on a small sample and claim generalization. Keep research, backtesting, paper trading, and any future live deployment separate. **The strategy cannot bypass the deterministic risk engine, and AI output cannot authorize execution.**

---

# 14. DETERMINISTIC RISK ENGINE

A centralized engine that neither the strategy nor AI can bypass. Controls (defaults in 5.5, all configurable and validated): max position size; max exposure per token; max total exposure; max open positions; max daily simulated loss; max drawdown; max slippage; min liquidity; max data age; cooldown after repeated failures; duplicate-order prevention; emergency stop; protection against invalid balances and impossible accounting states.

- Run checks **immediately before simulated order creation**, using the freshest data, not only at scan time.
- If critical data is missing, stale, contradictory, or invalid, reject the entry or enter a safe no-trade state.
- Record every risk rejection with its reason.
- **Emergency stop policy (explicit):** blocks all new entries. Existing simulated positions continue to be valued and may be closed only by simulated exit rules or by my explicit manual simulated-flatten action. The default does not auto-liquidate. Emergency stop can never create real orders.
- Emergency stop and reset are state-changing actions: protect the endpoints (Section 22) and write audit events.

---

# 15. REALISTIC PAPER-TRADING ENGINE

The paper engine is the only execution engine in the initial release. It must be a real simulation, not a calculation that assumes every trade fills at the displayed price.

## 15.1 Portfolio state
Starting capital; available quote balance; open positions; average entry price; position size; realized P&L; unrealized P&L; modeled fees; modeled slippage; total equity; peak equity; drawdown; closed-trade history. Use `bigint` base units and decimal ratios.

## 15.2 Ledger
- Implement an append-only, double-entry-style ledger. Balances and positions are derived from (or reconciled against) ledger entries.
- Every fill produces ledger entries in a single database transaction together with the order-state transition.
- A reconciliation function verifies that cash + position values + cumulative costs equal starting capital + realized + unrealized P&L. Run it after every fill in tests and periodically at runtime; a mismatch triggers an emergency stop and an audit event.
- Prevent negative balances unless explicitly modeled. Handle partial and full closes correctly. Document the P&L method (for example average-cost) once, and test it.

## 15.3 Order state machine
`PROPOSED → RISK_CHECKED → SUBMITTED_SIMULATED → FILLED_SIMULATED`, with terminal and side states: `PARTIALLY_FILLED_SIMULATED`, `REJECTED_RISK`, `FAILED_SIMULATED`, `EXPIRED`, `CANCELLED`. Persist every transition with timestamps and reasons. Illegal transitions throw and are tested.

**Idempotency:** derive an idempotency key from (strategy id + version, pair, side, source observation id or decision-time bucket). Enforce it with a database unique constraint, not only application logic. Replaying the same event must not create a second order or fill.

## 15.4 Execution model (all assumptions modeled, labeled, and documented in `docs/EXECUTION_MODEL.md`)
Model, with configurable parameters:
- **Latency:** sampled simulated landing delay (default a skewed distribution of roughly 0.4–3 s), and price movement during that delay using the freshest observation at the modeled execution time. If no sufficiently fresh execution-time observation exists, reject or apply the conservative policy; do not fill at a stale price.
- **Price impact:** constant-product approximation derived from pool liquidity. State the assumption plainly (for example, that quote-side reserves are approximately half of reported total liquidity) and label it as an estimate.
- **Spread and slippage** beyond impact, scaled by recent volatility.
- **Fees:** DEX/pool fee (use the pair's value if verifiably known, else a documented default), network base fee, priority fee, and a modeled tip. Buy and sell costs modeled separately.
- **Adverse selection / MEV:** a modeled extra cost drawn from a configurable distribution to represent sandwiching and front-running risk on illiquid memecoins. Label it clearly as a modeled assumption.
- **Failures:** configurable baseline failure/expiry probability that rises with volatility and low liquidity; failed attempts still incur modeled fees where realistic.
- **Exit realism:** a simulated exit requires an exit quote or a liquidity-based estimate; if liquidity is inadequate or the quote is unavailable, the exit is delayed, partially filled, or fails per the model; never assume a clean exit at the displayed price.
- **Partial fills** where supported by the liquidity model.

Distinguish and display four separate values: (1) last observed market price, (2) estimated executable price, (3) simulated fill price, (4) estimated portfolio valuation. They are not equal and must not be conflated.

If exact costs cannot be verified, use documented estimates and label them "modeled".

**Worked check the tests must reproduce:** a token rises 10% gross, and modeled round-trip costs total 4%; the reported net result must follow the implemented accounting model exactly, not the gross 10%.

A BUY signal is not a completed paper trade. The order, fill, portfolio, ledger, and history records must agree.

---

# 16. HISTORICAL REPLAY AND BACKTESTING

A distinct evaluation mode, not merely a performance chart. The dataset is primarily Solsnipe's own recorded snapshots (Section 9.3). If external historical data would require payment, follow Section 4 and do not purchase it.

## 16.1 Design requirements
- **Injected clock.** All strategy, scanner, risk, and execution code reads time and data through an injectable `Clock` and "as-of" data-access layer. In replay, the clock is set to the simulated time and every query is constrained to `observed_at <= as_of`. This is the structural defense against look-ahead bias.
- The replay uses the **same** scanner, strategy, risk engine, and execution model as paper trading, not a separate reimplementation.
- Process observations chronologically. No future prices, metadata, or risk information may influence earlier decisions.
- Model fees, spread, slippage, latency, and failed executions consistently with paper mode.
- Disclose data gaps. Handle tokens that later became inactive or collapsed transparently, as far as the data permits (avoid survivorship bias).
- Separate development and out-of-sample periods where practical (chronological split only; never shuffle).
- Compare against documented baselines: (a) no-trade, (b) random entry among `ACCEPT` candidates with the same exit rules, (c) buy-and-hold of all `ACCEPT` candidates for a fixed horizon.
- Record strategy version and configuration with every run.

## 16.2 Look-ahead canary tests (required)
Include tests that inject a future price spike or future risk change into the dataset and assert that decisions made before that time are unchanged. Include a test that the replay refuses to run if the as-of constraint is bypassed.

## 16.3 Reporting
Report: sample size and trade count; data coverage and gaps; gross and net performance; modeled execution costs; drawdown; relevant metrics (win rate, average win/loss, profit factor, exposure time); assumptions and known biases; evaluation period and baselines; dataset limitations.

**Honesty rules:** with a short recording window the result is pipeline validation, not evidence of an edge. If independent trades are fewer than a configured threshold (default 100), label results "INCONCLUSIVE — sample too small" and do not present performance as a proven edge. Do not cherry-pick tokens or time periods. Do not fabricate backtest results. If suitable data is unavailable, build the replay architecture, test it on clearly labeled fixtures, document the blocker, and say so.

---

# 17. AI RESEARCH ANALYST (optional; begin only after Milestone 6)

Use AI selectively where language understanding adds value: summarizing public project information, identifying unsupported promotional claims, comparing bullish and bearish evidence, explaining why a candidate deserves research, producing concise reports from verified input data.

- **AI is never the source of truth** for prices, balances, execution, risk calculations, or accounting.
- **AI may veto or flag; it may never approve, resize upward, or force an entry.** Its output is advisory text plus structured flags that can only make decisions more conservative.
- Outputs use a validated schema separating: observed facts, source-derived claims, inferences, unknowns, and confidence/limitations.
- Treat web pages, social posts, token metadata, and any external text as **untrusted input**: delimit it clearly, give the model no tools and no side effects, validate output against the schema, and never let it change system rules, expose credentials, or alter configuration.
- If the AI service is unavailable, the scanner and risk engine continue to operate.
- Do not call AI for every token or polling cycle; use it for selective research on shortlisted candidates, with a configurable daily call/cost cap.
- **The application's runtime AI needs its own credentials** (for example, an API key I create). Do not reuse the coding-gateway token. Follow Section 4 and ask before requiring it.

---

# 18. SOCIAL INTELLIGENCE (optional; deferred)

Keep modular and optional. Before requiring any source (X API or other), explain the service and access level, the feature that depends on it, verified pricing and rate limits, security implications, and cheaper alternatives. Potential signals: discussion volume, post frequency, engagement trends, repeated promotional patterns, contradictory claims, credibility signals when defensible, possible bot-like amplification explicitly labeled as an estimate.

Likes, reposts, follower counts, and sentiment scores are not proof of token quality. Do not scrape prohibited or access-controlled sources or bypass restrictions. Never ask for an X password, session cookies, or unnecessary secrets. Do not purchase a subscription without approval. If access is unavailable, document it and continue.

---

# 19. DASHBOARD AND VISUAL DESIGN

Build the functional dashboard first (Milestone 7, part 1); apply the visual identity second. Correctness and honesty over polish.

## 19.1 Design direction
**Bloomberg-style market terminal meets a refined isometric 16-bit pixel-art war room.** Dark charcoal/black foundation, high-contrast market data, electric green as the primary accent, restrained neon red and orange for risk and warnings, selective magenta accents.

- Typography: a clean monospace with tabular numerals for all data (bundle fonts locally so the UI works offline); a pixel display face used sparingly for headings and labels only, never for dense data.
- Define colors as design tokens with consistent semantics (green = positive/healthy, red = loss/fail, orange = warning/stale, magenta = highlight/selection). Meet accessible contrast; never rely on color alone for status.
- The pixel-art "war room" element (an isometric scene or panel) must be a **functional status display**: its indicators (provider status, recorder status, risk state, emergency stop) bind to real application state. Decorative-only animation that implies activity that is not happening is forbidden.
- Dense but readable layout, strong hierarchy, right-aligned numeric columns, purposeful spacing, desktop-first with sensible responsiveness, fast updates without unnecessary re-rendering.

Avoid: generic AI-dashboard aesthetics, pill-shaped buttons everywhere, decorative purple gradients, large empty hero sections, fake charts, fabricated activity, decorative metrics unrelated to real state, excessive animation, effects that hurt readability or performance.

## 19.2 Required areas
- **A. Market scanner:** discovered markets, price, price changes, liquidity, volume, pair age, risk statuses, data freshness, screening outcomes.
- **B. Candidate research:** per-rule evidence, risk checks with statuses and limitations, rejection reasons, research summaries (when Section 17 exists), explicit uncertainty.
- **C. Paper-trading terminal:** orders and states, fills, entry/exit prices, fees, modeled slippage, execution assumptions; the four distinct price values from 15.4.
- **D. Portfolio overview:** starting capital, equity, available balance, open exposure, realized and unrealized P&L, drawdown.
- **E. Performance analytics:** actual simulated performance, trade outcomes, costs (gross vs net), drawdown over time, strategy and baseline comparisons, sample-size warnings.
- **F. System health:** provider status, last successful update, measured latency, error counts, recorder status and gaps, database health, configuration status, safety self-check result, active execution mode (always displays PAPER).
- **G. Activity and audit log:** scanner decisions, risk rejections, simulated orders, failures, emergency-stop events, relevant configuration changes.

Every metric comes from actual application state or is explicitly labeled an estimate or test fixture. If data is unavailable, show an honest empty state. Show when observations are stale, delayed, missing, or contradictory; never display an old price as current.

The dashboard is a view. It is not the source of truth for decisions or accounting.

## 19.3 UI verification
Use Playwright to load the dashboard against seeded real-or-fixture state, capture screenshots, and actually inspect them for layout problems, unreadable contrast, misaligned numbers, and any display that does not match underlying data. Include a test asserting dashboard numbers equal values read from the database.

---

# 20. DATABASE AND STATE MANAGEMENT

SQLite (WAL) for the local-first deployment; do not add a remote database for appearance.

Persist: market observations; candidate evaluations; risk decisions; strategy decisions; simulated orders and transitions; fills; ledger entries; portfolio snapshots; trade history; provider health events; configuration versions; audit events; recorder heartbeats and gaps.

- Use migrations (versioned, forward-only, tested from an empty database).
- Use transactions so an order transition, fill, and ledger entries commit atomically.
- Enforce idempotency with unique constraints.
- Restart recovery must reconstruct the correct virtual portfolio from persisted state. Test by killing the process mid-workflow and restarting.
- Do not store credentials, seed phrases, private keys, or unnecessary sensitive data in the database or logs.

---

# 21. MODULE BOUNDARIES

Keep these responsibilities separate, with typed interfaces between them:

1. Market-data providers
2. Normalization and validation
3. Scanner
4. On-chain risk assessment
5. Research analyst (optional)
6. Strategy engine
7. Deterministic risk engine
8. Paper-trading execution and ledger
9. Persistence and audit
10. Application/API service layer
11. Dashboard

The AI analyst must not manipulate balances, bypass risk checks, or write arbitrary order records. Avoid unnecessary microservices, containers, and cloud infrastructure. Choose a coherent stack; do not adopt every technology mentioned in this document.

---

# 22. SECURITY AND SECRET MANAGEMENT

- Use environment variables or an appropriate local secrets mechanism. `.env.example` holds names and harmless placeholders only. Exclude `.env*`, keys, tokens, and sensitive configuration from Git.
- Redact secrets from logs and diagnostic output, including the coding-gateway token, and verify with a test.
- Minimum necessary permissions. Bind local services to `127.0.0.1`. Protect state-changing routes (emergency stop/reset, configuration changes, simulated flatten) with a local token or equivalent CSRF protection and origin checks.
- Validate all external input at boundaries. Treat all provider responses and token metadata as untrusted. Avoid unsafe shell execution and `eval`.
- Dependencies: pin versions, commit the lockfile, run the package manager's audit, avoid obscure packages and install scripts, and justify each dependency in `docs/DECISIONS.md`. Crypto-related packages are supply-chain targets; keep the footprint minimal.
- Document safe credential rotation and revocation.
- Never add wallet signing capability to the initial release.

## Third-party coding API gateway
The coding API gateway may be operated by a third party. Assume prompts, source code, logs, and other information sent through it may be visible to its operator. Do not claim it is trustworthy or private without verified evidence. Do not transmit wallet secrets, passwords, or unnecessary personal information. Do not assume a model identifier proves the model's identity or provider. Never print or commit the gateway token. If a sensitive file is not necessary for the task, do not read it.

---

# 23. PROVIDER STRATEGY AND COST CONTROL

Keep external dependencies minimal: market data (Dexscreener), Solana RPC for on-chain checks, optional AI service, optional social data. Do not assume every provider is necessary. Before requiring any additional provider, follow Section 4. Do not purchase credits, subscriptions, or infrastructure without approval. Handle authentication failures, quota exhaustion, rate limits, timeouts, outages, invalid responses, and schema changes. Degrade gracefully and report the limitation. Never fabricate data to conceal an integration failure.

---

# 24. TESTING AND VERIFICATION

A successful build or type check does not establish that Solsnipe works.

## 24.1 `npm run verify` (the definition of "done")
A single command that runs: type check, lint, the full test suite, the static paper-only safety scan (2.1), and an **end-to-end script** that: loads real (or clearly labeled recorded) data → normalizes and persists → scans → runs risk checks → generates a decision → applies pre-order risk checks → creates and fills a simulated order → closes it → verifies ledger reconciliation → **restarts the application and verifies the portfolio is recovered** → **replays a duplicate event and verifies no duplicate order or fill** → asserts dashboard data equals database state. A milestone is "done" only when this passes, not when you say it does.

## 24.2 Unit tests
Normalization; numeric and timestamp validation; freshness; scanner thresholds; risk-status handling (UNKNOWN never passes); position sizing; risk-engine decisions; fees and slippage; ledger and P&L; rounding; state-transition legality; idempotency; configuration validation.

## 24.3 Property-based tests (fast-check)
For arbitrary sequences of valid and invalid orders, fills, and price paths: cash never goes negative; ledger always reconciles; positions never go negative; net P&L never exceeds gross P&L minus costs; replaying a sequence twice yields identical state; processing duplicate events is idempotent.

## 24.4 Integration tests
Provider response handling; database persistence; order creation/closing; portfolio updates after fills; API behavior; restart recovery; dashboard-versus-database consistency.

## 24.5 Failure-injection tests
Missing critical data; stale prices; malformed responses; schema changes; provider timeouts; 429 rate limits; network loss; database failure and corruption handling; duplicate events; insufficient simulated balance; rejected orders; failed simulated fills; unavailable exit quotes; crash during an incomplete workflow; invalid configuration; AI service unavailable; emergency stop activated; clock skew.

## 24.6 Safety tests
Paper mode is the default and only mode; missing/invalid config cannot enable live execution; no signing/sending primitives exist; AI output cannot override risk controls; failed risk checks cannot create entries; duplicates cannot create duplicate orders or fills; secrets are gitignored and redacted from logs; restart preserves the virtual portfolio; UNKNOWN evidence is never treated as clean.

## 24.7 Independent adversarial review (required at Milestones 4 and 5)
Use a fresh subagent or a clearly separate review pass whose only job is to break the work. Give it the code and this specification, not your reasoning. Have it hunt for: floating-point money math; any path to order creation that skips the risk engine; UNKNOWN/NOT_SUPPORTED treated as PASS; look-ahead leaks; non-idempotent paths; secrets in logs; mis-reconciling ledger cases; and any live-execution pathway. Fix findings, add regression tests, and record the review and its results in `BUILD_STATUS.md`.

## 24.8 Honest reporting
Report the actual tests executed, their results, and unresolved failures. Never invent passing tests. If a test is skipped, say why.

---

# 25. MACOS AND WINDOWS COMPATIBILITY

Maintain the project on an Apple Silicon Mac and a Windows PC. Prefer portable Node/TypeScript workflows; use project-local dependencies; keep package scripts consistent; avoid hardcoded absolute paths; use cross-platform path handling; avoid shell-specific scripting in `package.json` (use Node scripts or cross-platform tools); normalize line endings via `.gitattributes`; verify native dependencies install on both platforms; document OS-specific setup and limitations. Git synchronizes source between machines; databases and recorded snapshots are local and gitignored, so document that simulated state and recorded data do not sync via Git. Never commit secrets or machine-specific configuration.

---

# 26. RESUMABILITY

If the session is interrupted, the project must be understandable and resumable.

`BUILD_STATUS.md` always contains: current milestone; implemented features; working startup and stop commands (app, recorder, verify); architecture and key files; tests executed with actual results; known defects; missing dependencies or credentials; "Awaiting user" items; unfinished tasks; the single highest-priority next action; and the recorder's current status (running or not, since when, gap count).

Commit working states frequently. Do not delete working code to meet a target. If a feature is incomplete, preserve the working core and document the next step. On every (re)start of a session: read `BUILD_STATUS.md`, run `git status` and `git log -5`, check whether the recorder is still running, then continue.

---

# 27. SCOPE CONTROL

The first deliverable is one complete, reliable paper-trading workflow. Do not expand into multiple providers, social sentiment, advanced AI agents, extensive analytics, or elaborate dashboard polish before the core workflow works and passes `npm run verify`. If a dependency blocks progress, isolate it behind an interface and continue independent work; do not spend the session repeatedly attempting an unavailable service.

## 27.1 The vertical slice (must exist and be demonstrated)
1. Retrieve a real market-data record from a verified provider.
2. Validate and normalize it, including timestamps and freshness.
3. Persist it.
4. Run scanning and the available on-chain risk checks.
5. Generate an explainable strategy decision.
6. Apply deterministic risk checks immediately before simulated order creation.
7. Create a simulated order in a virtual portfolio.
8. Simulate delay, fees, slippage, price impact, and failures.
9. Update balances, positions, P&L, and history correctly.
10. Display the resulting state in the dashboard.
11. Restart and verify persisted state is recovered.
12. Replay a duplicate event and verify no duplicate order or fill.

---

# 28. ACCEPTANCE CRITERIA

Do not mark a criterion complete without evidence. If one cannot be met, explain why and what remains.

**Functionality:** starts with documented commands; at least one real market-data integration verified, or its access blocker documented and isolated; data validated and normalized; scanner returns ACCEPT/REJECT/REVIEW; risk checks distinguish PASS/FAIL/UNKNOWN/NOT_SUPPORTED; missing evidence never treated as safety; decisions explainable; deterministic risk controls run before order creation; orders can be opened, updated, and closed; fees and execution assumptions included in accounting; portfolio and history persist across restarts; duplicate-event protection works; dashboard reflects underlying state; the snapshot recorder runs and reports its gaps.

**Execution realism:** observed price, executable estimate, simulated fill, and valuation are separate; delay and costs are modeled with documented assumptions; gross and net performance reported separately; stale data and unavailable exits handled conservatively; modeled costs never presented as verified costs.

**Backtesting:** replay is chronological; look-ahead is prevented by design and tested with canaries; results disclose sample size, coverage, costs, assumptions, limitations; baselines used; small-sample results labeled inconclusive; unavailable data reported honestly.

**Safety:** paper trading is the only mode; no live submission path exists and the static scan proves no signing/sending code; no seed phrase or private key requested or stored; risk controls cannot be overridden by AI; invalid or stale critical data fails safely; secrets excluded from Git and redacted from logs; no paid dependency purchased without approval.

**Quality:** critical logic has automated tests including property-based and failure-injection tests; independent adversarial review completed and findings addressed; accounting reconciles; restart recovery verified; the vertical slice exercised end to end; documentation explains installation, configuration, operation, and limitations; `BUILD_STATUS.md` is accurate.

**A successful build alone does not mean Solsnipe is complete.**

---

# 29. FUTURE LIVE-TRADING PHASE — NOT AUTHORIZED

Live trading is outside the scope of this release. Do not implement or activate live transaction submission, even disabled, as a shortcut. A future phase may be considered only after: paper trading has been evaluated under realistic assumptions; scanner, strategy, and risk behavior have been reviewed; failure handling and recovery tested; transaction construction and validation separately reviewed; key management and signing security designed; position, exposure, loss, and spending limits specified; emergency-stop behavior tested; architecture, risks, dependencies, and costs reviewed; and I have explicitly approved the separate implementation. Any future live component must be isolated, validate transactions before signing, enforce independent spending limits, and fail safely.

Approval to build Solsnipe is not approval to trade real funds.

---

# 30. FINAL OPERATING RULES AND REPORTING

Throughout the project: inspect before changing; plan before implementing; ask before requiring authentication, permissions, or purchases; verify before claiming success; use real data where available; label simulated data honestly; keep paper trading the only mode; keep the risk engine independent of AI; treat unknown evidence as unknown; make execution assumptions explicit; prevent look-ahead bias; never invent APIs, credentials, metrics, test results, or performance; never expose secrets; preserve working code and resumable progress; prioritize correctness over polish and demonstrated functionality over feature count; do not claim completion based on compilation or rendering alone.

At the end of each milestone and each work session, report concisely:
1. What is working now.
2. What you tested, and the actual results (include `npm run verify` output summary).
3. What remains incomplete.
4. What dependencies or actions you need from me.
5. Whether costs or additional permissions are involved.
6. Recorder status (running, coverage, gaps).
7. The highest-priority next step.
8. The exact command to continue.

If a genuine blocker requires my input, explain the requirement, pause that part of the work, and continue independent tasks.

---

# START NOW

1. Save this document to `docs/MASTER_PROMPT.md` and write the short `CLAUDE.md` (Section 0).
2. Inspect the repository and environment (Section 6) without exposing secrets.
3. Confirm Git state and preserve existing work.
4. Identify required installations, authentication, permissions, or paid-service blockers (Section 4).
5. Create or update `README.md`, `.gitignore`, `.gitattributes`, `.env.example`, `BUILD_STATUS.md`, and `.claude/settings.json`.
6. Establish the foundation and the paper-trading safety boundary with its mechanical enforcement (Section 2.1).
7. Get the snapshot recorder running as early as possible.
8. Implement the vertical slice, test the real workflow, accounting, persistence, and restart recovery.
9. Report verified progress and the next highest-priority action.

**Do not submit real trades. Do not purchase services without approval. Do not fabricate data or test results. Build the smallest reliable version first, prove that it works, and expand only after the core workflow is verified.**
