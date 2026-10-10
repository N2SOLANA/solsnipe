/**
 * Append-only simulated ledger (M4, spec §15.2). PAPER-ONLY.
 *
 * - In-memory double-entry-style journal. Every fill appends debit/credit
 *   entries that net to zero; entries are never mutated or removed.
 * - P&L method: AVERAGE COST (single documented method). Buys raise the cost
 *   basis at fill price; sells relieve quantity at the running average cost;
 *   realized P&L = proceeds − relieved cost − sell-side fees. Missing
 *   realized/cost detail on a close throws (fail closed, never invent P&L).
 * - Money: cash and quantities are bigint lamports/base units. Prices are
 *   decimal STRINGS parsed via Decimal at use sites — never float money
 *   (§5.2). Totals are floored conservatively: costs round against the trader
 *   (costs up, proceeds down); quantity math uses integer truncation toward
 *   zero, which is likewise conservative for proceeds.
 * - reconcile() verifies
 *     cash + open-position value at mark + cumulative buy fees
 *       == start + realized + unrealized
 *   at a caller-supplied mark price, and throws on mismatch. Buy costs are
 *   intentionally NOT a separate term (cash is already net of them and the
 *   remaining basis sits inside unrealized); sell fees are likewise already
 *   deducted from both cash and realized. Run it after
 *   every fill in tests and periodically at runtime; wire a mismatch to an
 *   emergency stop plus an audit event (§15.2).
 */

import { assertPaperMode } from "../safety/executionMode.js";
import { Decimal } from "decimal.js";

export type LedgerEntryKind =
  | "OPEN"
  | "BUY_FILL"
  | "SELL_FILL"
  | "BUY_FEE"
  | "SELL_FEE"
  | "REALIZED_PNL"
  | "AUDIT";

export interface LedgerEntry {
  seq: number;
  atMs: number;
  kind: LedgerEntryKind;
  token: string;
  /** Signed bigint amount (lamports for cash legs; base units for asset legs). */
  amount: bigint;
  /** Decimal price string used for this leg, or null for non-fill legs. */
  price: string | null;
  detail: string;
}

export interface PositionView {
  token: string;
  quantityBaseUnits: bigint;
  /** Average cost in quote lamports per base unit, decimal string; "0" when flat. */
  averageCost: string;
  costBasisLamports: bigint;
}

export interface LedgerSnapshot {
  startLamports: bigint;
  cashLamports: bigint;
  realizedPnlLamports: bigint;
  cumulativeBuyFeeLamports: bigint;
  entryCount: number;
}

function requireToken(token: string): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("token must be a non-empty string");
  }
  return token;
}

function requireCashScope(token: string): void {
  if (token !== "__CASH__") {
    throw new Error(`cash leg must use token "__CASH__" (got "${token}")`);
  }
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Parse a non-negative decimal price string; throws on anything else. */
function parsePrice(price: string): Decimal {
  if (typeof price !== "string" || !DECIMAL_RE.test(price)) {
    throw new Error(`price must be a non-negative decimal string (got "${price}")`);
  }
  return new Decimal(price);
}

/**
 * quote = floor(qty * price) for a BUY (costs rounded UP against the trader
 * is handled by the caller-provided fee legs; the fill leg itself is exact
 * floor so proceeds are never overstated). Shared helper for mark valuation.
 */
function quoteFloor(qty: bigint, price: Decimal): bigint {
  return BigInt(price.mul(qty.toString()).toDecimalPlaces(0, Decimal.ROUND_FLOOR).toString());
}

export class Ledger {
  private entries: LedgerEntry[] = [];
  private seq = 0;
  private readonly startLamports: bigint;
  private cashLamports: bigint;
  private realizedPnlLamports = 0n;
  private cumulativeBuyFeeLamports = 0n;
  /** token -> { qty base units, cost basis lamports }. */
  private positions = new Map<string, { qty: bigint; cost: bigint }>();

  constructor(startLamports: bigint) {
    assertPaperMode();
    if (startLamports <= 0n) throw new Error("startLamports must be positive");
    this.startLamports = startLamports;
    this.cashLamports = startLamports;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  snapshot(): LedgerSnapshot {
    return {
      startLamports: this.startLamports,
      cashLamports: this.cashLamports,
      realizedPnlLamports: this.realizedPnlLamports,
      cumulativeBuyFeeLamports: this.cumulativeBuyFeeLamports,
      entryCount: this.entries.length,
    };
  }

  journal(): readonly LedgerEntry[] {
    return this.entries;
  }

  position(token: string): PositionView | undefined {
    const p = this.positions.get(requireToken(token));
    if (p === undefined || p.qty <= 0n) return undefined;
    return {
      token,
      quantityBaseUnits: p.qty,
      averageCost: new Decimal(p.cost.toString()).div(p.qty.toString()).toString(),
      costBasisLamports: p.cost,
    };
  }

  openPositions(): PositionView[] {
    const out: PositionView[] = [];
    for (const [token, p] of this.positions) {
      if (p.qty > 0n) {
        out.push({
          token,
          quantityBaseUnits: p.qty,
          averageCost: new Decimal(p.cost.toString()).div(p.qty.toString()).toString(),
          costBasisLamports: p.cost,
        });
      }
    }
    return out;
  }

  private append(entry: Omit<LedgerEntry, "seq">): void {
    this.seq += 1;
    this.entries.push({ ...entry, seq: this.seq });
  }

  private cashOut(amount: bigint, atMs: number, detail: string): void {
    if (amount < 0n) throw new Error("cash leg amount must be signed by kind, not negative here");
    if (amount > this.cashLamports) {
      throw new Error(
        `insufficient simulated cash: need ${String(amount)}, have ${String(this.cashLamports)}`,
      );
    }
    this.cashLamports -= amount;
    this.append({ atMs, kind: "BUY_FILL", token: "__CASH__", amount: -amount, price: null, detail });
  }

  /**
   * Record a simulated BUY fill: quantity of base units at a decimal-string
   * price, plus a separately stated fee (lamports, >= 0). Appends the
   * fill + fee legs atomically (all-or-nothing: validated before mutating).
   */
  buyFill(input: {
    token: string;
    quantityBaseUnits: bigint;
    fillPrice: string;
    feeLamports: bigint;
    orderId: string;
    atMs: number;
  }): void {
    assertPaperMode();
    const token = requireToken(input.token);
    if (token === "__CASH__") throw new Error('token "__CASH__" is reserved for cash legs');
    if (input.quantityBaseUnits <= 0n) throw new Error("quantityBaseUnits must be positive");
    if (input.feeLamports < 0n) throw new Error("feeLamports must be >= 0");
    const price = parsePrice(input.fillPrice);
    if (price.isZero()) throw new Error("fillPrice must be positive");
    const cost = quoteFloor(input.quantityBaseUnits, price);
    if (cost <= 0n) throw new Error("fill cost must be positive at this price/quantity");
    const total = cost + input.feeLamports;
    if (total > this.cashLamports) {
      throw new Error(
        `insufficient simulated cash: need ${String(total)}, have ${String(this.cashLamports)}`,
      );
    }
    if (!Number.isInteger(input.atMs) || input.atMs < 0) {
      throw new Error("atMs must be a non-negative integer");
    }

    this.cashLamports -= total;
    this.cumulativeBuyFeeLamports += input.feeLamports;
    const slot = this.positions.get(token) ?? { qty: 0n, cost: 0n };
    slot.qty += input.quantityBaseUnits;
    slot.cost += cost;
    this.positions.set(token, slot);
    this.append({
      atMs: input.atMs,
      kind: "BUY_FILL",
      token,
      amount: input.quantityBaseUnits,
      price: input.fillPrice,
      detail: `order=${input.orderId} qty=${String(input.quantityBaseUnits)} cost=${String(cost)}`,
    });
    this.append({
      atMs: input.atMs,
      kind: "BUY_FEE",
      token: "__CASH__",
      amount: -input.feeLamports,
      price: null,
      detail: `order=${input.orderId} fee=${String(input.feeLamports)}`,
    });
  }

  /**
   * Record a simulated SELL fill. The caller supplies proceeds and fee, plus
   * the relieved-cost detail so P&L is never invented inside the ledger:
   * realizedPnlDelta = proceeds − relievedCost − fee. Both must be stated.
   */
  sellFill(input: {
    token: string;
    quantityBaseUnits: bigint;
    fillPrice: string;
    proceedsLamports: bigint;
    feeLamports: bigint;
    relievedCostLamports: bigint;
    realizedPnlDeltaLamports: bigint;
    orderId: string;
    atMs: number;
  }): void {
    assertPaperMode();
    const token = requireToken(input.token);
    if (token === "__CASH__") throw new Error('token "__CASH__" is reserved for cash legs');
    if (input.quantityBaseUnits <= 0n) throw new Error("quantityBaseUnits must be positive");
    if (input.proceedsLamports < 0n) throw new Error("proceedsLamports must be >= 0");
    if (input.feeLamports < 0n) throw new Error("feeLamports must be >= 0");
    if (input.relievedCostLamports < 0n) throw new Error("relievedCostLamports must be >= 0");
    const price = parsePrice(input.fillPrice);
    if (price.isZero()) throw new Error("fillPrice must be positive");
    if (input.proceedsLamports < input.feeLamports) {
      throw new Error("fee cannot exceed proceeds (would invent negative cash)");
    }
    const expected = input.proceedsLamports - input.relievedCostLamports - input.feeLamports;
    if (expected !== input.realizedPnlDeltaLamports) {
      throw new Error(
        "realizedPnlDelta must equal proceeds − relievedCost − fee (average-cost accounting)",
      );
    }
    const slot = this.positions.get(token);
    if (slot === undefined || slot.qty < input.quantityBaseUnits) {
      throw new Error(`insufficient simulated position in ${token}`);
    }
    if (slot.cost < input.relievedCostLamports) {
      throw new Error("relieved cost cannot exceed position cost basis");
    }
    if (!Number.isInteger(input.atMs) || input.atMs < 0) {
      throw new Error("atMs must be a non-negative integer");
    }

    slot.qty -= input.quantityBaseUnits;
    slot.cost -= input.relievedCostLamports;
    if (slot.qty === 0n) this.positions.delete(token);
    else this.positions.set(token, slot);
    const net = input.proceedsLamports - input.feeLamports;
    this.cashLamports += net;
    this.realizedPnlLamports += input.realizedPnlDeltaLamports;
    this.append({
      atMs: input.atMs,
      kind: "SELL_FILL",
      token,
      amount: -input.quantityBaseUnits,
      price: input.fillPrice,
      detail: `order=${input.orderId} qty=${String(input.quantityBaseUnits)} proceeds=${String(input.proceedsLamports)}`,
    });
    this.append({
      atMs: input.atMs,
      kind: "SELL_FEE",
      token: "__CASH__",
      amount: -input.feeLamports,
      price: null,
      detail: `order=${input.orderId} fee=${String(input.feeLamports)}`,
    });
    this.append({
      atMs: input.atMs,
      kind: "REALIZED_PNL",
      token,
      amount: input.realizedPnlDeltaLamports,
      price: null,
      detail: `order=${input.orderId} relieved=${String(input.relievedCostLamports)}`,
    });
  }

  audit(note: string, atMs: number): void {
    assertPaperMode();
    if (typeof note !== "string" || note.trim() === "") throw new Error("audit note required");
    this.append({ atMs, kind: "AUDIT", token: "__CASH__", amount: 0n, price: null, detail: note });
  }

  /**
   * Average-cost helper for callers closing a position: given the current
   * basis and a quantity to relieve, returns the pro-rata relieved cost
   * (floor — conservative for proceeds) plus the realized delta. The ledger
   * itself never derives these; the caller passes them back into sellFill so
   * the accounting identity is checkable.
   */
  quoteClose(
    token: string,
    quantityBaseUnits: bigint,
    proceedsLamports: bigint,
    feeLamports: bigint,
  ): { relievedCostLamports: bigint; realizedPnlDeltaLamports: bigint } {
    const slot = this.positions.get(requireToken(token));
    if (slot === undefined || slot.qty <= 0n) throw new Error(`no open position in ${token}`);
    if (quantityBaseUnits <= 0n || quantityBaseUnits > slot.qty) {
      throw new Error("close quantity must be within the open position");
    }
    const relieved =
      quantityBaseUnits === slot.qty
        ? slot.cost
        : BigInt(
            new Decimal(slot.cost.toString())
              .mul(quantityBaseUnits.toString())
              .div(slot.qty.toString())
              .toDecimalPlaces(0, Decimal.ROUND_FLOOR)
              .toString(),
          );
    return {
      relievedCostLamports: relieved,
      realizedPnlDeltaLamports: proceedsLamports - relieved - feeLamports,
    };
  }

  /**
   * Reconciliation identity (spec §15.2):
   *   cash + openValue(mark) + cumulativeBuyFees == start + realized + unrealized
   * where unrealized = openValue(mark) − openCostBasis. Buy costs need no
   * separate term: cash is already net of them and the remaining basis sits
   * inside unrealized, so adding them would double-count. Sell fees need no
   * term either: they are already deducted from both cash and realized.
   * Derivation (buy cost C, buy fees Fb, proceeds P, sell fees Fs, relieved
   * cost C−B, open basis B, value V): cash = S−C−Fb+P−Fs and
   * realized+unrealized = P−C−Fs+V, so cash+V+Fb = S+realized+unrealized
   * exactly. Throws on mismatch.
   */
  reconcile(markPrices: Readonly<Record<string, string>>): {
    cash: bigint;
    openValue: bigint;
    openCost: bigint;
    unrealized: bigint;
  } {
    assertPaperMode();
    let openValue = 0n;
    let openCost = 0n;
    for (const [token, p] of this.positions) {
      if (p.qty <= 0n) continue;
      const raw = markPrices[token];
      if (typeof raw !== "string") throw new Error(`missing mark price for ${token}`);
      const mark = parsePrice(raw);
      if (mark.isZero()) throw new Error(`mark price for ${token} must be positive`);
      openValue += quoteFloor(p.qty, mark);
      openCost += p.cost;
    }
    const unrealized = openValue - openCost;
    const left = this.cashLamports + openValue + this.cumulativeBuyFeeLamports;
    const right = this.startLamports + this.realizedPnlLamports + unrealized;
    if (left !== right) {
      throw new Error(
        `ledger mismatch: cash+value+costs=${String(left)} != start+realized+unrealized=${String(right)}`,
      );
    }
    return { cash: this.cashLamports, openValue, openCost, unrealized };
  }

  /** Test-only: expose the reserved-scope guard for the cashOut path. */
  debugCashOutForTest(amount: bigint, atMs: number, token: string): void {
    requireCashScope(token);
    this.cashOut(amount, atMs, "test");
  }
}
