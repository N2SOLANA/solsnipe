/**
 * Paper-trading persistence (spec §15.2, §20). Binds the in-memory engine to
 * the app SQLite database with atomic boundaries:
 *
 * - Every fill persists order-state transition + ledger entries + position
 *   snapshot + portfolio cash in ONE database transaction. A crash leaves
 *   either the whole fill or none of it — never a half-written fill.
 * - Idempotency is database-enforced: sim_orders.idempotency_key UNIQUE.
 *   Replaying a persisted order's key after restart returns the stored row;
 *   INSERT OR IGNORE makes duplicate persistence a no-op.
 * - Restart recovery rebuilds Ledger + OrderStore state from the journal and
 *   portfolio tables, then runs reconcile() against caller-supplied marks.
 *   Recovery failure throws (caller fails closed into emergency stop).
 *
 * Money crosses the boundary as TEXT (bigint lamports, decimal strings) —
 * never REAL, never float. JSON serialization of bigints is banned here;
 * String(bigint) round-trips losslessly.
 */
import type { DatabaseSync } from "node:sqlite";
import { assertPaperMode } from "../safety/executionMode.js";
import { Ledger, type LedgerEntry } from "../ledger/ledger.js";
import { OrderStore, type OrderRecord, type OrderTransition } from "../trading/orders.js";

export interface PersistedOrder extends OrderRecord {
  mint: string;
  pairAddress: string;
}

function bigToText(v: bigint): string {
  if (typeof v !== "bigint") throw new Error("expected bigint for money field");
  return v.toString();
}

function textToBig(s: unknown, label: string): bigint {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) {
    throw new Error(`corrupt ${label}: not an integer string`);
  }
  return BigInt(s);
}

export class PaperStore {
  constructor(private readonly db: DatabaseSync) {
    assertPaperMode();
  }

  /** Atomic: order row + transitions + ledger entries + positions + cash. */
  persistFill(args: {
    order: PersistedOrder;
    transitions: readonly OrderTransition[];
    newLedgerEntries: readonly LedgerEntry[];
    ledger: Ledger;
    cashLamports: bigint;
    realizedPnlLamports: bigint;
    cumulativeBuyFeeLamports: bigint;
    startLamports: bigint;
    emergencyStop: boolean;
    nowMs: number;
  }): void {
    assertPaperMode();
    const a = args;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO sim_orders (id, idempotency_key, side, state, mint, pair_address, notional_lamports, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state
      `).run(
        a.order.id, a.order.idempotencyKey, a.order.side, a.order.state,
        a.order.mint, a.order.pairAddress, bigToText(a.order.notionalLamports), a.order.createdAtMs,
      );
      const insTrans = this.db.prepare(`
        INSERT INTO sim_order_transitions (order_id, from_state, to_state, at_ms, reason)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const t of a.transitions) {
        insTrans.run(t.orderId, t.from, t.to, t.atMs, t.reason);
      }
      const insEntry = this.db.prepare(`
        INSERT INTO sim_ledger_entries (at_ms, kind, token, amount, price, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const e of a.newLedgerEntries) {
        insEntry.run(e.atMs, e.kind, e.token, bigToText(e.amount), e.price, e.detail);
      }
      // Positions: full snapshot replace (derived from journal; small N).
      this.db.prepare("DELETE FROM sim_positions").run();
      const insPos = this.db.prepare(`
        INSERT INTO sim_positions (token, qty_base_units, cost_basis_lamports, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const p of a.ledger.openPositions()) {
        insPos.run(p.token, bigToText(p.quantityBaseUnits), bigToText(p.costBasisLamports), a.nowMs);
      }
      this.db.prepare(`
        INSERT INTO sim_portfolio (id, start_lamports, cash_lamports, realized_pnl_lamports, cumulative_buy_fee_lamports, emergency_stop, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cash_lamports=excluded.cash_lamports,
          realized_pnl_lamports=excluded.realized_pnl_lamports,
          cumulative_buy_fee_lamports=excluded.cumulative_buy_fee_lamports,
          emergency_stop=excluded.emergency_stop,
          updated_at=excluded.updated_at
      `).run(
        bigToText(a.startLamports), bigToText(a.cashLamports),
        bigToText(a.realizedPnlLamports), bigToText(a.cumulativeBuyFeeLamports),
        a.emergencyStop ? 1 : 0, a.nowMs,
      );
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw err;
    }
  }

  /** Insert-or-ignore by idempotency key. Returns true if newly inserted. */
  persistOrderProposed(order: PersistedOrder): boolean {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO sim_orders (id, idempotency_key, side, state, mint, pair_address, notional_lamports, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.id, order.idempotencyKey, order.side, order.state,
      order.mint, order.pairAddress, bigToText(order.notionalLamports), order.createdAtMs,
    ) as { changes?: number };
    return (r.changes ?? 0) > 0;
  }

  /** Recovery: rebuild orders + ledger journal + cash from durable state. */
  recover(): {
    orders: PersistedOrder[];
    transitions: OrderTransition[];
    ledgerEntries: { atMs: number; kind: string; token: string; amount: string; price: string | null; detail: string }[];
    portfolio: {
      startLamports: bigint; cashLamports: bigint; realizedPnlLamports: bigint;
      cumulativeBuyFeeLamports: bigint; emergencyStop: boolean;
    } | null;
    positions: { token: string; qty: bigint; cost: bigint }[];
  } {
    assertPaperMode();
    const orders = (this.db.prepare("SELECT * FROM sim_orders").all() as {
      id: string; idempotency_key: string; side: "BUY" | "SELL"; state: OrderRecord["state"];
      mint: string; pair_address: string; notional_lamports: string; created_at: number;
    }[]).map((r) => ({
      id: r.id,
      idempotencyKey: r.idempotency_key,
      side: r.side,
      state: r.state,
      notionalLamports: textToBig(r.notional_lamports, "notional"),
      createdAtMs: r.created_at,
      mint: r.mint,
      pairAddress: r.pair_address,
    }));
    const transitions = (this.db.prepare(
      "SELECT order_id AS orderId, from_state AS \"from\", to_state AS \"to\", at_ms AS atMs, reason FROM sim_order_transitions ORDER BY id",
    ).all() as unknown) as OrderTransition[];
    const ledgerEntries = this.db.prepare(
      "SELECT at_ms AS atMs, kind, token, amount, price, detail FROM sim_ledger_entries ORDER BY seq",
    ).all() as { atMs: number; kind: string; token: string; amount: string; price: string | null; detail: string }[];
    const portRow = this.db.prepare("SELECT * FROM sim_portfolio WHERE id = 1").get() as {
      start_lamports: string; cash_lamports: string; realized_pnl_lamports: string;
      cumulative_buy_fee_lamports: string; emergency_stop: number;
    } | undefined;
    const positions = (this.db.prepare("SELECT * FROM sim_positions").all() as {
      token: string; qty_base_units: string; cost_basis_lamports: string;
    }[]).map((r) => ({
      token: r.token,
      qty: textToBig(r.qty_base_units, "qty"),
      cost: textToBig(r.cost_basis_lamports, "cost"),
    }));
    return {
      orders,
      transitions,
      ledgerEntries,
      portfolio: portRow === undefined ? null : {
        startLamports: textToBig(portRow.start_lamports, "start"),
        cashLamports: textToBig(portRow.cash_lamports, "cash"),
        realizedPnlLamports: textToBig(portRow.realized_pnl_lamports, "realized"),
        cumulativeBuyFeeLamports: textToBig(portRow.cumulative_buy_fee_lamports, "buyfee"),
        emergencyStop: portRow.emergency_stop !== 0,
      },
      positions,
    };
  }

  /**
   * Restart recovery, verified by REPLAY through the audited Ledger code path
   * (not by parallel arithmetic that could drift from it):
   *  1. Group journal legs by orderId (parsed from `detail: order=<id>`).
   *  2. Replay each fill through a fresh Ledger: buyFill for BUY groups
   *     (qty+price from the asset leg, fee from the fee leg); sellFill for
   *     SELL groups (relieved cost from the replay ledger's own running
   *     basis via quoteClose, proceeds re-derived as realized+relieved+fee
   *     and re-verified by sellFill's identity check).
   *  3. Compare replayed cash/realized/buyFees/positions against
   *     sim_portfolio + sim_positions. Any divergence throws — the caller
   *     fails closed into emergency stop, never trades on corrupt state.
   */
  verifyRecovery(
    entries: readonly {
      kind: string; token: string; amount: string; price: string | null;
      detail: string; atMs: number;
    }[],
    portfolio: {
      startLamports: bigint; cashLamports: bigint; realizedPnlLamports: bigint;
      cumulativeBuyFeeLamports: bigint;
    },
    positions: readonly { token: string; qty: bigint; cost: bigint }[],
  ): void {
    assertPaperMode();
    for (const e of entries) {
      if (
        e.kind !== "BUY_FILL" && e.kind !== "SELL_FILL" && e.kind !== "BUY_FEE" &&
        e.kind !== "SELL_FEE" && e.kind !== "REALIZED_PNL" &&
        e.kind !== "OPEN" && e.kind !== "AUDIT"
      ) {
        throw new Error(`unknown ledger kind in journal: ${e.kind}`);
      }
    }
    interface Leg { kind: string; token: string; amount: bigint; price: string | null; atMs: number }
    const byOrder = new Map<string, Leg[]>();
    for (const e of entries) {
      if (e.kind === "OPEN" || e.kind === "AUDIT") continue;
      const m = /order=([^\s]+)/.exec(e.detail);
      if (m === null) throw new Error(`journal entry missing order id: ${e.detail.slice(0, 80)}`);
      const list = byOrder.get(m[1] as string) ?? [];
      list.push({ kind: e.kind, token: e.token, amount: textToBig(e.amount, "journal amount"), price: e.price, atMs: e.atMs });
      byOrder.set(m[1] as string, list);
    }
    const replay = new Ledger(portfolio.startLamports);
    for (const [orderId, legs] of byOrder) {
      const fill = legs.find((l) => l.kind === "BUY_FILL" || l.kind === "SELL_FILL");
      const fee = legs.find((l) => l.kind === "BUY_FEE" || l.kind === "SELL_FEE");
      if (fill === undefined || fee === undefined) {
        throw new Error(`incomplete fill group for order ${orderId}`);
      }
      if (fill.price === null) throw new Error(`fill leg missing price for order ${orderId}`);
      if (fill.kind === "BUY_FILL") {
        replay.buyFill({
          token: fill.token,
          quantityBaseUnits: fill.amount,
          fillPrice: fill.price,
          feeLamports: -fee.amount,
          orderId,
          atMs: fill.atMs,
        });
      } else {
        const pnlLeg = legs.find((l) => l.kind === "REALIZED_PNL");
        if (pnlLeg === undefined) throw new Error(`sell group missing realized leg for order ${orderId}`);
        const { relievedCostLamports } = replay.quoteClose(fill.token, -fill.amount, 0n, 0n);
        const proceeds = pnlLeg.amount + relievedCostLamports + -fee.amount;
        replay.sellFill({
          token: fill.token,
          quantityBaseUnits: -fill.amount,
          fillPrice: fill.price,
          proceedsLamports: proceeds,
          feeLamports: -fee.amount,
          relievedCostLamports,
          realizedPnlDeltaLamports: pnlLeg.amount,
          orderId,
          atMs: fill.atMs,
        });
      }
    }
    const snap = replay.snapshot();
    if (snap.cashLamports !== portfolio.cashLamports) {
      throw new Error(
        `recovery mismatch: replayed cash ${String(snap.cashLamports)} != portfolio ${String(portfolio.cashLamports)}`,
      );
    }
    if (snap.realizedPnlLamports !== portfolio.realizedPnlLamports) {
      throw new Error("recovery mismatch: replayed realized != portfolio realized");
    }
    if (snap.cumulativeBuyFeeLamports !== portfolio.cumulativeBuyFeeLamports) {
      throw new Error("recovery mismatch: replayed buy fees != portfolio buy fees");
    }
    const replayPos = replay.openPositions();
    if (replayPos.length !== positions.length) {
      throw new Error(
        `recovery mismatch: replayed ${replayPos.length} positions != snapshot ${positions.length}`,
      );
    }
    for (const p of positions) {
      const r = replayPos.find((x) => x.token === p.token);
      if (r === undefined || r.quantityBaseUnits !== p.qty || r.costBasisLamports !== p.cost) {
        throw new Error(`recovery mismatch: position divergence for ${p.token}`);
      }
    }
  }

  countOrders(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM sim_orders").get() as { n: number }).n);
  }
}

export type { OrderStore };
export { Ledger };
