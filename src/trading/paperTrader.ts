/**
 * Minimal paper-trader daemon: scheduled, idempotent, fail-closed.
 *
 * - Polls the snapshot database for observations newer than the durable
 *   cursor, scans them, applies risk/strategy/risk-engine gates, persists
 *   either an ORDER_PROPOSED fill or an explicit BLOCKED audit event.
 * - Idempotency across polls and restarts: durable cursor + UNIQUE
 *   observation events + UNIQUE order idempotency keys. Repeats converge.
 * - Fail-closed evidence policy: entries require every required risk check
 *   PASS. Unsupported, stale, or missing evidence records BLOCKED_RISK; it
 *   never invents evidence, relaxes the gate, or submits anything on-chain.
 * - PAPER-ONLY: asserts EXECUTION_MODE at construction and every poll. No
 *   network calls, no signing, no transaction submission path exists here.
 */
import type { DatabaseSync } from "node:sqlite";
import { assertPaperMode } from "../safety/executionMode.js";
import type { NormalizedObservation } from "../providers/types.js";
import { scanObservation } from "../scanner/scanner.js";
import { runRiskChecks } from "../risk/checks.js";
import type { MintInfo } from "../risk/solanaRpc.js";
import { evaluateEntry } from "../strategy/baseline.js";
import { RiskEngine } from "./riskEngine.js";
import { OrderStore, buildIdempotencyKey } from "./orders.js";
import { Ledger } from "../ledger/ledger.js";
import { PaperStore } from "./paperStore.js";

export interface PaperTraderOptions {
  snapshotDb: DatabaseSync;
  paperStore: PaperStore;
  /** Verified mint evidence keyed by mint; absent mints stay NOT_SUPPORTED. */
  mintEvidence?: Map<string, MintInfo>;
  strategyId?: string;
  startLamports?: bigint;
  /** Max observations processed per poll (backpressure cap). */
  maxBatch?: number;
  nowMs?: () => number;
}

interface SnapshotRow {
  id: number;
  mint: string;
  pair_address: string;
  dex_id: string;
  chain_id: string;
  quote_mint: string | null;
  price_usd: string | null;
  price_native: string | null;
  liquidity_usd: string | null;
  liquidity_base: string | null;
  liquidity_quote: string | null;
  volume_h24: string | null;
  volume_h6: string | null;
  volume_h1: string | null;
  volume_m5: string | null;
  txns_h24_buys: number | null;
  txns_h24_sells: number | null;
  price_change_h24: string | null;
  market_cap: string | null;
  fdv: string | null;
  pair_created_at: number | null;
  observed_at: number;
  source: string;
  latency_ms: number;
  raw_hash: string;
  validation_notes: string;
}

function rowToObservation(r: SnapshotRow): NormalizedObservation {
  let notes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.validation_notes);
    if (Array.isArray(parsed)) notes = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    notes = ["unparseable validation_notes"];
  }
  return {
    mint: r.mint,
    pairAddress: r.pair_address,
    dexId: r.dex_id,
    chainId: r.chain_id,
    quoteMint: r.quote_mint,
    priceUsd: r.price_usd,
    priceNative: r.price_native,
    liquidityUsd: r.liquidity_usd,
    liquidityBase: r.liquidity_base,
    liquidityQuote: r.liquidity_quote,
    volumeH24: r.volume_h24,
    volumeH6: r.volume_h6,
    volumeH1: r.volume_h1,
    volumeM5: r.volume_m5,
    txnsH24Buys: r.txns_h24_buys,
    txnsH24Sells: r.txns_h24_sells,
    priceChangeH24: r.price_change_h24,
    marketCap: r.market_cap,
    fdv: r.fdv,
    pairCreatedAt: r.pair_created_at,
    observedAt: r.observed_at,
    source: r.source,
    latencyMs: r.latency_ms,
    rawHash: r.raw_hash,
    validationNotes: notes,
  };
}

export interface PaperTraderPollResult {
  processed: number;
  blockedScan: number;
  blockedRisk: number;
  ordersProposed: number;
  errors: number;
  cursor: number;
}

export class PaperTrader {
  private readonly orders = new OrderStore();
  private readonly seenKeys = new Set<string>();
  private readonly strategyId: string;
  private readonly startLamports: bigint;
  private readonly maxBatch: number;
  private readonly nowMs: () => number;
  private readonly mintEvidence: Map<string, MintInfo>;

  constructor(private readonly opts: PaperTraderOptions) {
    assertPaperMode();
    this.strategyId = opts.strategyId ?? "baseline";
    this.startLamports = opts.startLamports ?? 10_000_000_000n;
    this.maxBatch = opts.maxBatch ?? 200;
    this.nowMs = opts.nowMs ?? Date.now;
    this.mintEvidence = opts.mintEvidence ?? new Map();
  }

  /** One bounded poll: process rows newer than the durable cursor. */
  pollOnce(): PaperTraderPollResult {
    assertPaperMode();
    const cursor = this.opts.paperStore.getDaemonCursor();
    const rows = (this.opts.snapshotDb.prepare(
      `SELECT * FROM observations WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(cursor, this.maxBatch) as unknown) as SnapshotRow[];
    const result: PaperTraderPollResult = {
      processed: 0, blockedScan: 0, blockedRisk: 0, ordersProposed: 0, errors: 0, cursor,
    };
    const engine = new RiskEngine();
    for (const row of rows) {
      result.processed += 1;
      result.cursor = row.id;
      try {
        this.processRow(row, engine, result);
      } catch (err) {
        result.errors += 1;
        this.opts.paperStore.appendDaemonEvent({
          observationId: row.id,
          observedAt: row.observed_at,
          mint: row.mint,
          pairAddress: row.pair_address,
          scannerOutcome: "ERROR",
          riskAllowed: false,
          action: "ERROR",
          detail: err instanceof Error ? err.message : String(err),
          createdAt: this.nowMs(),
        });
      }
    }
    return result;
  }

  private processRow(
    row: SnapshotRow,
    engine: RiskEngine,
    result: PaperTraderPollResult,
  ): void {
    const store = this.opts.paperStore;
    const now = this.nowMs();
    const obs = rowToObservation(row);
    const scan = scanObservation(obs, { nowMs: now });
    if (scan.outcome !== "ACCEPT") {
      result.blockedScan += 1;
      store.appendDaemonEvent({
        observationId: row.id, observedAt: obs.observedAt, mint: obs.mint,
        pairAddress: obs.pairAddress, scannerOutcome: scan.outcome,
        riskAllowed: false, action: "BLOCKED_SCAN",
        detail: scan.explanation.slice(0, 500), createdAt: now,
      });
      return;
    }
    const risk = runRiskChecks(obs, now, { mintInfo: this.mintEvidence.get(obs.mint) ?? null });
    if (!risk.entryAllowed) {
      result.blockedRisk += 1;
      store.appendDaemonEvent({
        observationId: row.id, observedAt: obs.observedAt, mint: obs.mint,
        pairAddress: obs.pairAddress, scannerOutcome: scan.outcome,
        riskAllowed: false, action: "BLOCKED_RISK",
        detail: risk.summary.slice(0, 500), createdAt: now,
      });
      return;
    }
    // Full PASS bar met: strategy → pre-order engine → paper fill.
    const decision = evaluateEntry({
      obs, scan, risk, modeledCostFraction: "0.02", dataAgeMs: now - obs.observedAt,
    });
    if (decision.decision !== "ENTRY") {
      result.blockedRisk += 1;
      store.appendDaemonEvent({
        observationId: row.id, observedAt: obs.observedAt, mint: obs.mint,
        pairAddress: obs.pairAddress, scannerOutcome: scan.outcome,
        riskAllowed: true, action: "BLOCKED_RISK",
        detail: `strategy declined: ${decision.reasons.join("; ").slice(0, 400)}`, createdAt: now,
      });
      return;
    }
    const key = buildIdempotencyKey({
      strategyId: this.strategyId,
      strategyVersion: "baseline-v1",
      pair: `${obs.mint}|${obs.pairAddress}`,
      side: "BUY",
      observationId: obs.rawHash,
    });
    // Recovered cash baseline from durable portfolio (default: start capital).
    const rec = store.recover();
    const cash = rec.portfolio?.cashLamports ?? this.startLamports;
    const equity = rec.portfolio === null ? this.startLamports : rec.portfolio.cashLamports;
    const gate = engine.check({
      nowMs: now,
      side: "BUY",
      token: obs.mint,
      notionalLamports: (equity * 4n) / 100n,
      availableCashLamports: cash,
      currentEquityLamports: equity,
      startOfDayEquityLamports: equity,
      startOfDayUtcMs: now - (now % 86_400_000),
      peakEquityLamports: equity,
      openPositionCount: rec.positions.length,
      openPositions: [],
      poolLiquidityUsd: obs.liquidityUsd === null ? null : Number(obs.liquidityUsd),
      positionShareOfLiquidity: 0.001,
      modeledEntryCostFraction: 0.02,
      scannerDataAgeMs: now - obs.observedAt,
      riskDataAgeMs: 0,
      consecutiveFailures: 0,
      lastFailureMs: null,
      idempotencyKey: key,
      isDuplicate: (k) => this.seenKeys.has(k),
      emergencyStop: rec.portfolio?.emergencyStop ?? false,
    });
    if (!gate.allowed) {
      result.blockedRisk += 1;
      store.appendDaemonEvent({
        observationId: row.id, observedAt: obs.observedAt, mint: obs.mint,
        pairAddress: obs.pairAddress, scannerOutcome: scan.outcome,
        riskAllowed: false, action: "BLOCKED_RISK",
        detail: `pre-order engine: ${gate.reasons.join(", ").slice(0, 400)}`, createdAt: now,
      });
      return;
    }
    this.seenKeys.add(key);
    const order = this.orders.propose({
      side: "BUY", notionalLamports: (equity * 4n) / 100n, idempotencyKey: key, nowMs: now,
    });
    this.orders.transition(order.id, "RISK_CHECKED", "daemon risk allowed", now);
    this.orders.transition(order.id, "SUBMITTED_SIMULATED", "daemon submit", now);
    const inserted = store.persistOrderProposed({
      ...order, mint: obs.mint, pairAddress: obs.pairAddress,
    });
    result.ordersProposed += inserted ? 1 : 0;
    store.appendDaemonEvent({
      observationId: row.id, observedAt: obs.observedAt, mint: obs.mint,
      pairAddress: obs.pairAddress, scannerOutcome: scan.outcome,
      riskAllowed: true, action: "ORDER_PROPOSED",
      detail: `order ${order.id}${inserted ? "" : " (duplicate)"}`, createdAt: now,
    });
    void Ledger;
  }
}
