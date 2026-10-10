/**
 * Simulated order lifecycle (M4, spec §15.3). PAPER-ONLY.
 *
 * State machine:
 *   PROPOSED -> RISK_CHECKED -> SUBMITTED_SIMULATED -> FILLED_SIMULATED
 * Side/terminal states: PARTIALLY_FILLED_SIMULATED, REJECTED_RISK,
 * FAILED_SIMULATED, EXPIRED, CANCELLED.
 *
 * - Illegal transitions throw (and are tested).
 * - Every transition is timestamped and reasoned; a per-order history log is
 *   kept in memory for audit.
 * - Fail closed: all entry points assert EXECUTION_MODE === "PAPER".
 * - Idempotency (§15.3): the key is strategyId + strategyVersion + pair +
 *   side + observationId-or-decision-time-bucket. The in-memory seen-set here
 *   is the application-level guard; production wiring must ALSO enforce a
 *   database UNIQUE constraint on the key (documented on the store), because
 *   app logic alone is not sufficient. Replaying the same event returns the
 *   existing order and creates no second order or fill.
 */

import { assertPaperMode } from "../safety/executionMode.js";

export type OrderSide = "BUY" | "SELL";

export type OrderState =
  | "PROPOSED"
  | "RISK_CHECKED"
  | "SUBMITTED_SIMULATED"
  | "FILLED_SIMULATED"
  | "PARTIALLY_FILLED_SIMULATED"
  | "REJECTED_RISK"
  | "FAILED_SIMULATED"
  | "EXPIRED"
  | "CANCELLED";

export interface IdempotencyFields {
  strategyId: string;
  strategyVersion: string;
  pair: string;
  side: OrderSide;
  /** Source observation id when available; otherwise a decision-time bucket. */
  observationId?: string | undefined;
  timeBucketMs?: number | undefined;
  bucketSizeMs?: number | undefined;
}

export interface OrderRecord {
  id: string;
  idempotencyKey: string;
  side: OrderSide;
  state: OrderState;
  notionalLamports: bigint;
  createdAtMs: number;
}

export interface OrderTransition {
  orderId: string;
  from: OrderState;
  to: OrderState;
  atMs: number;
  reason: string;
}

const TERMINAL: ReadonlySet<OrderState> = new Set([
  "FILLED_SIMULATED",
  "REJECTED_RISK",
  "FAILED_SIMULATED",
  "EXPIRED",
  "CANCELLED",
]);

/** Allowed next states for every state (empty = terminal). */
const TRANSITIONS: Readonly<Record<OrderState, ReadonlySet<OrderState>>> = {
  PROPOSED: new Set(["RISK_CHECKED", "REJECTED_RISK", "EXPIRED", "CANCELLED"]),
  RISK_CHECKED: new Set(["SUBMITTED_SIMULATED", "REJECTED_RISK", "EXPIRED", "CANCELLED"]),
  SUBMITTED_SIMULATED: new Set([
    "FILLED_SIMULATED",
    "PARTIALLY_FILLED_SIMULATED",
    "FAILED_SIMULATED",
    "EXPIRED",
    "CANCELLED",
  ]),
  // Partial fills may complete, keep filling, or terminate.
  PARTIALLY_FILLED_SIMULATED: new Set([
    "PARTIALLY_FILLED_SIMULATED",
    "FILLED_SIMULATED",
    "FAILED_SIMULATED",
    "EXPIRED",
    "CANCELLED",
  ]),
  FILLED_SIMULATED: new Set([]),
  REJECTED_RISK: new Set([]),
  FAILED_SIMULATED: new Set([]),
  EXPIRED: new Set([]),
  CANCELLED: new Set([]),
};

export function isTerminal(state: OrderState): boolean {
  return TERMINAL.has(state);
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Build the idempotency key. Exactly one of observationId or
 * (timeBucketMs, bucketSizeMs) is required: without a disambiguator the key
 * would collide across unrelated events, and an empty fallback would collide
 * trivially.
 */
export function buildIdempotencyKey(fields: IdempotencyFields): string {
  assertPaperMode();
  const strategyId = requireNonEmpty(fields.strategyId, "strategyId");
  const strategyVersion = requireNonEmpty(fields.strategyVersion, "strategyVersion");
  const pair = requireNonEmpty(fields.pair, "pair");
  if (fields.side !== "BUY" && fields.side !== "SELL") {
    throw new Error(`side must be BUY or SELL (got ${String(fields.side)})`);
  }
  const hasObs = fields.observationId !== undefined && fields.observationId !== "";
  const hasBucket =
    fields.timeBucketMs !== undefined &&
    fields.bucketSizeMs !== undefined &&
    Number.isInteger(fields.timeBucketMs) &&
    Number.isInteger(fields.bucketSizeMs) &&
    (fields.bucketSizeMs as number) > 0;
  if (!hasObs && !hasBucket) {
    throw new Error("idempotency requires observationId or (timeBucketMs + bucketSizeMs)");
  }
  if (fields.timeBucketMs !== undefined || fields.bucketSizeMs !== undefined) {
    if (!hasBucket) {
      throw new Error("timeBucketMs and bucketSizeMs must be positive integers together");
    }
    requireNonEmpty(String(fields.timeBucketMs), "timeBucketMs");
  }
  const tail = hasObs
    ? `obs:${fields.observationId as string}`
    : `bucket:${String(Math.floor((fields.timeBucketMs as number) / (fields.bucketSizeMs as number)))}:${String(fields.bucketSizeMs)}`;
  return [strategyId, strategyVersion, pair, fields.side, tail].join("|");
}

/**
 * In-memory order store with idempotent submit. Production wiring: persist
 * orders AND transitions in a single database transaction per fill (§15.2),
 * with a UNIQUE constraint on idempotencyKey — the in-memory seen-set does
 * not survive restarts, so the DB constraint is the binding guarantee.
 */
export class OrderStore {
  private orders = new Map<string, OrderRecord>();
  private byKey = new Map<string, string>();
  private transitions: OrderTransition[] = [];
  private counter = 0;

  get size(): number {
    return this.orders.size;
  }

  /** All orders (for persistence snapshots). Returns live references. */
  allOrders(): readonly OrderRecord[] {
    return [...this.orders.values()];
  }

  getOrder(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  getByIdempotencyKey(key: string): OrderRecord | undefined {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : this.orders.get(id);
  }

  history(orderId: string): OrderTransition[] {
    return this.transitions.filter((t) => t.orderId === orderId);
  }

  allTransitions(): readonly OrderTransition[] {
    return this.transitions;
  }

  propose(input: {
    side: OrderSide;
    notionalLamports: bigint;
    idempotencyKey: string;
    nowMs: number;
  }): OrderRecord {
    assertPaperMode();
    if (input.side !== "BUY" && input.side !== "SELL") {
      throw new Error(`side must be BUY or SELL (got ${String(input.side)})`);
    }
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    if (input.notionalLamports <= 0n) {
      throw new Error("notionalLamports must be positive");
    }
    if (!Number.isInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error("nowMs must be a non-negative integer");
    }
    // Idempotent replay: the same event returns the existing order.
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) return existing;

    this.counter += 1;
    const record: OrderRecord = {
      id: `sim-${this.counter}`,
      idempotencyKey: input.idempotencyKey,
      side: input.side,
      state: "PROPOSED",
      notionalLamports: input.notionalLamports,
      createdAtMs: input.nowMs,
    };
    this.orders.set(record.id, record);
    this.byKey.set(input.idempotencyKey, record.id);
    this.transitions.push({
      orderId: record.id,
      from: "PROPOSED",
      to: "PROPOSED",
      atMs: input.nowMs,
      reason: "created",
    });
    return record;
  }

  transition(orderId: string, to: OrderState, reason: string, nowMs: number): OrderRecord {
    assertPaperMode();
    const order = this.orders.get(orderId);
    if (order === undefined) throw new Error(`unknown order ${orderId}`);
    if (!TRANSITIONS[order.state].has(to)) {
      throw new Error(`illegal transition ${order.state} -> ${to} (order ${orderId})`);
    }
    requireNonEmpty(reason, "reason");
    if (!Number.isInteger(nowMs) || nowMs < 0) {
      throw new Error("nowMs must be a non-negative integer");
    }
    const from = order.state;
    order.state = to;
    this.transitions.push({ orderId, from, to, atMs: nowMs, reason });
    return order;
  }
}
