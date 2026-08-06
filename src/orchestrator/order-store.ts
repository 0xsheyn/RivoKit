/**
 * Order persistence.
 *
 * Two layers guard state here, and they guard different things:
 *
 *   - `assertTransition` refuses an illegal lifecycle move before any write,
 *     so the caller gets a clear INVALID_STATE instead of a constraint error
 *   - the database constraints refuse a state that is internally inconsistent
 *     (released without eurc_out, rebate that is not the surplus, duplicate
 *     payment hash) no matter what the application believes
 *
 * The second layer is the one that matters when the first is wrong. Application
 * code can be bypassed, refactored, or simply mistaken; a CHECK constraint
 * cannot. Every write below is expected to satisfy both — if the database ever
 * rejects one, the application logic is broken, not the constraint.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Address, Hex } from "viem";
import type { PaymentInfo } from "../escrow/payment-info.ts";
import {
  fromPayoutWire, toPayoutWire,
  type PayoutInstruction, type PayoutInstructionWire,
} from "../payout/instruction.ts";
import type { PayoutTarget } from "../payout/rail.ts";
import type { CpnPaymentState } from "../ramp/cpn-state.ts";
import { assertTransition, type OrderState } from "./state-machine.ts";
import type { TimeoutKind, Wedge } from "./policy.ts";

export type OrderRecord = {
  id: string;
  payer: string;
  receiver: string;
  operator: string;
  token: string;
  price_eur: string;
  buffer_bps: number;
  usdc_amount: string | null;
  max_amount: string;
  salt: string;
  min_fee_bps: number;
  max_fee_bps: number;
  fee_receiver: string;
  receiving_chain: string;
  mode: "escrow" | "direct";
  /** Where the money ends up: the seller's Arc wallet, or their bank. */
  payout_to: PayoutTarget;
  wedge: Wedge;
  state: OrderState;
  timeout_kind: TimeoutKind;
  timeout_deadline: string;
  pre_approval_expiry: string;
  authorization_expiry: string;
  refund_expiry: string;
  payment_info_hash: string | null;
  eurc_out: string | null;
  rebate: string | null;
  failure_reason: string | null;
  created_at: string;
  funded_at: string | null;
  settled_at: string | null;
};

export type PaymentKind =
  | "funding" | "authorize" | "capture" | "void"
  | "refund" | "reclaim" | "swap" | "rebate" | "bridge_back"
  /** The off-ramp broadcast — source token leaving for a payment network. */
  | "payout";

export type RecordPaymentParams = {
  orderId: string;
  nonce: string;
  kind: PaymentKind;
  status?: "pending" | "confirmed" | "failed";
  txHash?: string;
  chain?: string;
  amountMinor?: bigint;
  errorReason?: string;
};

/** A `payments` row as it comes back out — `amount` normalised to string. */
export type PaymentRecord = {
  kind: PaymentKind;
  status: string;
  tx_hash: string | null;
  chain: string | null;
  amount: string | null;
};

export type CreateOrderParams = {
  id: string;
  paymentInfo: PaymentInfo;
  priceEURMinor: bigint;
  usdcAmountMinor: bigint | null;
  bufferBps: number;
  receivingChain: string;
  mode: "escrow" | "direct";
  /** Defaults to "wallet" — settle to EURC on Arc and stop, the original behaviour. */
  payoutTo?: PayoutTarget;
  wedge: Wedge;
  timeoutKind: TimeoutKind;
  timeoutDeadline: number;
  paymentInfoHash: Hex;
};

export type TransitionPatch = Partial<{
  eurcOutMinor: bigint;
  rebateMinor: bigint;
  failureReason: string;
  fundedAt: Date;
  settledAt: Date;
  usdcAmountMinor: bigint;
}>;

/** A CPN cash-out as persisted. Money in integer minor units, as strings out. */
export type CpnPaymentRecord = {
  payment_id: string;
  order_id: string | null;
  corridor: string;
  sender_address: string;
  signed_by: "server" | "wallet";
  source_minor: string;
  source_currency: string;
  destination_minor: string;
  destination_currency: string;
  destination_scale: number;
  status: CpnPaymentState;
  transaction_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  /**
   * The unsigned transaction held between prepare and broadcast.
   *
   * Only present on a row read back with `getCpnPayment` — `listCpnPayments`
   * leaves it out, because the history panel polls that list and has no use for
   * a payload of this size. Absent once the intent has been broadcast.
   */
  prepared?: unknown;
};

export type RecordCpnPaymentParams = {
  paymentId: string;
  orderId?: string | null;
  corridor: string;
  senderAddress: string;
  signedBy: "server" | "wallet";
  sourceMinor: bigint;
  sourceCurrency: string;
  destinationMinor: bigint;
  destinationCurrency: string;
  destinationScale?: number;
  status: CpnPaymentState;
  transactionId?: string | null;
  /**
   * Live-only state a later request has to pick up: the unsigned CPN
   * transaction plus its corridor. Stored because prepare and broadcast are two
   * requests, and on a serverless host they are two PROCESSES — see
   * `0008_cpn_prepared.sql`.
   */
  prepared?: unknown;
};

/**
 * What the orchestrator needs from persistence — declared here, not inferred
 * from whichever implementation happens to exist.
 *
 * `createOrderStore` below is the Supabase/Postgres implementation, and it is
 * the only one shipped. Anything else that satisfies this interface can be
 * injected into `createRivoKit`, with one caveat worth stating in the type's
 * own documentation rather than discovering later: the shipped implementation
 * leans on database CHECK constraints as a SECOND guard (released without
 * `eurc_out`, a rebate that is not the surplus, a duplicate payment nonce). A
 * store without those constraints keeps the application-level guard in
 * `assertTransition` but silently loses the one that survives an application
 * bug. Implement the constraints, or accept a weaker guarantee knowingly.
 */
export interface OrderStore {
  create(params: CreateOrderParams): Promise<OrderRecord>;
  get(id: string): Promise<OrderRecord | null>;
  transition(id: string, to: OrderState, patch?: TransitionPatch): Promise<OrderRecord>;
  recordPayment(params: RecordPaymentParams): Promise<unknown>;
  /** Returns the existing row on a nonce collision instead of throwing. */
  recordPaymentIdempotent(params: RecordPaymentParams): Promise<unknown>;
  /**
   * Settle a payment row that was written before its outcome was known.
   *
   * Most rows are written once, already confirmed, because the transaction had
   * landed before the write. An off-ramp broadcast is the exception: it is
   * recorded at submit time, when it is genuinely `pending` and its on-chain
   * hash does not exist yet. Without this the row would still say `pending` on
   * an order that has since been paid out — a ledger disagreeing with the
   * thing it is a ledger of.
   *
   * `txHash` is not optional in practice for a confirmed row: `confirmed_has_tx`
   * rejects one without it, on the principle that an unverifiable confirmation
   * is worth less than an honest `pending`.
   */
  advancePayment(
    nonce: string,
    patch: { status: "confirmed" | "failed"; txHash?: string; errorReason?: string },
  ): Promise<PaymentRecord | null>;
  recordEvent(params: {
    orderId?: string;
    type: string;
    payload: unknown;
    sigVerified?: boolean;
  }): Promise<void>;
  listPayments(orderId: string): Promise<PaymentRecord[]>;
  listOrders(limit?: number): Promise<OrderRecord[]>;
  listEvents(orderId: string): Promise<Array<{ type: string; payload: unknown; received_at: string }>>;

  /**
   * The most recent events of one type, across every order — newest first.
   *
   * The other event reads all start from an order id, which is the right shape
   * when the order is what you are looking at. It is the wrong shape for a
   * question like "when did EURC last reach a seller wallet": the answer is not
   * about any particular order, and finding it through the order list means
   * reading every order's whole event log to keep one row.
   */
  listEventsByType(
    type: string,
    limit?: number,
  ): Promise<Array<{ order_id: string | null; type: string; payload: unknown; received_at: string }>>;

  /**
   * The same three reads, for MANY orders at once.
   *
   * They exist because a board that lists N orders was making 5N round trips —
   * `status`, `get`, `listEvents`, `listPayments`, `getPayout` per order — on a
   * four-second poll. Thirty orders meant a hundred and fifty queries every
   * tick, which is not a slow query anywhere; it is a slow SHAPE. One query per
   * table, keyed back to the order, is the same information for three.
   *
   * Each returns a map keyed by order id, and an order with nothing recorded is
   * present with an empty value rather than missing — a caller reading a map
   * should not have to distinguish "no events" from "not asked about".
   */
  listEventsFor(orderIds: readonly string[]): Promise<Record<string, Array<{ type: string; payload: unknown; received_at: string }>>>;
  listPaymentsFor(orderIds: readonly string[]): Promise<Record<string, PaymentRecord[]>>;
  listPayoutsFor(orderIds: readonly string[]): Promise<Record<string, PayoutInstruction | null>>;
  listPending(): Promise<OrderRecord[]>;
  findOrderIdByTxHash(txHash: string): Promise<string | null>;
  /** Persist the payout instruction emitted on release. */
  savePayout(orderId: string, payout: PayoutInstruction): Promise<void>;
  getPayout(orderId: string): Promise<PayoutInstruction | null>;

  /** CPN cash-outs — see `cpn_payments`. A payout may span many orders, so
   *  these stand apart from the order lifecycle rather than inside it. */
  recordCpnPayment(params: RecordCpnPaymentParams): Promise<CpnPaymentRecord>;
  getCpnPayment(paymentId: string): Promise<CpnPaymentRecord | null>;
  /** Move a cash-out to a new state. The caller decides whether the move is
   *  legal (`applyPaymentEvent`); this only writes. */
  advanceCpnPayment(
    paymentId: string,
    status: CpnPaymentState,
    patch?: { transactionId?: string; failureReason?: string },
  ): Promise<CpnPaymentRecord>;
  listCpnPayments(limit?: number): Promise<CpnPaymentRecord[]>;
  /**
   * Attach or drop the unsigned transaction a broadcast will need.
   *
   * Separate from `advanceCpnPayment` because clearing it is not a state
   * change: a broadcast payment is still CREATED at the moment it stops needing
   * its intent, and folding the two would make "forget the intent" require a
   * transition that has not happened yet.
   */
  setCpnPrepared(paymentId: string, prepared: unknown | null): Promise<void>;

  deleteOrder(id: string): Promise<void>;
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/**
 * Money columns as they come back over the wire.
 *
 * PostgREST serialises Postgres `bigint` as a JSON NUMBER, not a string. That
 * is a precision hazard: JS numbers are exact only below 2^53, which in
 * micro-units is about 9 billion USDC. Today's amounts are nowhere near it, but
 * the whole point of storing money as integers is that the representation never
 * silently rounds — so normalise to string at the boundary and let callers
 * build bigints from that.
 *
 * Also affects equality: a caller comparing `order.eurc_out` against
 * `value.toString()` gets false for identical amounts unless this runs.
 */
const MONEY_COLUMNS = [
  "price_eur", "usdc_amount", "max_amount", "salt", "eurc_out", "rebate",
] as const;

function normalizeOrder<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = { ...(row as Record<string, unknown>) };
  for (const key of MONEY_COLUMNS) {
    const v = out[key];
    if (typeof v === "number") out[key] = BigInt(v).toString();
  }
  return out as T;
}

/** Same bigint-over-the-wire hazard as MONEY_COLUMNS, for the cash-out table. */
function normalizeCpn<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = { ...(row as Record<string, unknown>) };
  for (const key of ["source_minor", "destination_minor"]) {
    const v = out[key];
    if (typeof v === "number") out[key] = BigInt(v).toString();
  }
  return out as T;
}

function normalizeAmount<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = { ...(row as Record<string, unknown>) };
  if (typeof out.amount === "number") out.amount = BigInt(out.amount).toString();
  return out as T;
}

export function createOrderStore(url: string, serviceKey: string): OrderStore {
  // Service role: RLS is deny-all with no policies, so only this key can read
  // or write. It must never reach a browser.
  const db: SupabaseClient = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const fail = (op: string, error: { message: string } | null) => {
    if (error) throw new Error(`order-store ${op}: ${error.message}`);
  };

  return {
    async create(params: {
      id: string;
      paymentInfo: PaymentInfo;
      priceEURMinor: bigint;
      usdcAmountMinor: bigint | null;
      bufferBps: number;
      receivingChain: string;
      mode: "escrow" | "direct";
      payoutTo?: PayoutTarget;
      wedge: Wedge;
      timeoutKind: TimeoutKind;
      timeoutDeadline: number;
      paymentInfoHash: Hex;
    }): Promise<OrderRecord> {
      const pi = params.paymentInfo;
      const { data, error } = await db
        .from("orders")
        .insert({
          id: params.id,
          payer: pi.payer,
          receiver: pi.receiver,
          operator: pi.operator,
          token: pi.token,
          price_eur: params.priceEURMinor.toString(),
          buffer_bps: params.bufferBps,
          usdc_amount: params.usdcAmountMinor?.toString() ?? null,
          max_amount: pi.maxAmount.toString(),
          salt: pi.salt.toString(),
          min_fee_bps: pi.minFeeBps,
          max_fee_bps: pi.maxFeeBps,
          fee_receiver: pi.feeReceiver,
          receiving_chain: params.receivingChain,
          mode: params.mode,
          payout_to: params.payoutTo ?? "wallet",
          wedge: params.wedge,
          state: "created",
          timeout_kind: params.timeoutKind,
          timeout_deadline: iso(params.timeoutDeadline),
          pre_approval_expiry: iso(pi.preApprovalExpiry),
          authorization_expiry: iso(pi.authorizationExpiry),
          refund_expiry: iso(pi.refundExpiry),
          payment_info_hash: params.paymentInfoHash,
        })
        .select()
        .single();
      fail("create", error);
      return normalizeOrder(data as OrderRecord);
    },

    async get(id: string): Promise<OrderRecord | null> {
      const { data, error } = await db.from("orders").select().eq("id", id).maybeSingle();
      fail("get", error);
      return data ? normalizeOrder(data as OrderRecord) : null;
    },

    /**
     * Move an order to a new state.
     *
     * Reads the current state first so the transition is checked against what
     * is actually stored, not what the caller assumes. That matters for retries
     * after an interrupted run — the chain may have advanced while the process
     * was gone.
     */
    async transition(
      id: string,
      to: OrderState,
      patch: Partial<{
        eurcOutMinor: bigint;
        rebateMinor: bigint;
        failureReason: string;
        fundedAt: Date;
        settledAt: Date;
        usdcAmountMinor: bigint;
      }> = {},
    ): Promise<OrderRecord> {
      const current = await this.get(id);
      if (!current) throw new Error(`order-store transition: no such order ${id}`);

      assertTransition(current.state, to);

      const update: Record<string, unknown> = { state: to };
      if (patch.eurcOutMinor !== undefined) update.eurc_out = patch.eurcOutMinor.toString();
      if (patch.rebateMinor !== undefined) update.rebate = patch.rebateMinor.toString();
      if (patch.failureReason !== undefined) update.failure_reason = patch.failureReason;
      if (patch.usdcAmountMinor !== undefined) update.usdc_amount = patch.usdcAmountMinor.toString();
      if (patch.fundedAt !== undefined) update.funded_at = patch.fundedAt.toISOString();
      if (patch.settledAt !== undefined) update.settled_at = patch.settledAt.toISOString();

      const { data, error } = await db
        .from("orders")
        .update(update)
        .eq("id", id)
        .select()
        .single();
      fail(`transition ${current.state}→${to}`, error);
      return normalizeOrder(data as OrderRecord);
    },

    /**
     * Record an on-chain action.
     *
     * `nonce` is UNIQUE in the schema, which is what actually makes retries
     * safe: a replayed step reuses its nonce and collides instead of moving
     * money twice. Callers should derive it deterministically, not randomly.
     */
    async recordPayment(params: RecordPaymentParams) {
      const { data, error } = await db
        .from("payments")
        .insert({
          order_id: params.orderId,
          nonce: params.nonce,
          kind: params.kind,
          status: params.status ?? "pending",
          tx_hash: params.txHash ?? null,
          chain: params.chain ?? null,
          amount: params.amountMinor?.toString() ?? null,
          error_reason: params.errorReason ?? null,
          confirmed_at: params.status === "confirmed" ? new Date().toISOString() : null,
        })
        .select()
        .single();
      fail("recordPayment", error);
      return normalizeAmount(data);
    },

    /**
     * Record a payment, treating a replay as success rather than an error.
     *
     * `nonce` is UNIQUE, so a retry of an already-recorded step hits a unique
     * violation (Postgres 23505). For a reconciliation sweep that is the desired
     * outcome — the step is already on the books — not a failure. Returns the
     * existing row on collision so callers can proceed idempotently.
     */
    async recordPaymentIdempotent(params: RecordPaymentParams) {
      const { data, error } = await db
        .from("payments")
        .insert({
          order_id: params.orderId,
          nonce: params.nonce,
          kind: params.kind,
          status: params.status ?? "pending",
          tx_hash: params.txHash ?? null,
          chain: params.chain ?? null,
          amount: params.amountMinor?.toString() ?? null,
          error_reason: params.errorReason ?? null,
          confirmed_at: params.status === "confirmed" ? new Date().toISOString() : null,
        })
        .select()
        .single();
      if (error) {
        if (error.code === "23505") {
          const existing = await db.from("payments").select().eq("nonce", params.nonce).maybeSingle();
          return existing.data ? normalizeAmount(existing.data) : null;
        }
        fail("recordPaymentIdempotent", error);
      }
      return normalizeAmount(data);
    },

    /**
     * Settle an already-recorded payment row. Keyed by nonce because that is
     * the column the idempotency guard already makes unique — the same handle
     * the row was written under.
     */
    async advancePayment(
      nonce: string,
      patch: { status: "confirmed" | "failed"; txHash?: string; errorReason?: string },
    ): Promise<PaymentRecord | null> {
      if (patch.status === "confirmed" && !patch.txHash) {
        // Caught here rather than left to the constraint: the database would
        // reject it too, but with a message about `confirmed_has_tx` instead of
        // about the caller that had no hash to give.
        throw new Error(
          `advancePayment(${nonce}): a confirmed payment needs a txHash — ` +
            "an unverifiable confirmation is worse than an honest pending.",
        );
      }
      const { data, error } = await db
        .from("payments")
        .update({
          status: patch.status,
          ...(patch.txHash ? { tx_hash: patch.txHash } : {}),
          ...(patch.errorReason ? { error_reason: patch.errorReason } : {}),
          confirmed_at: patch.status === "confirmed" ? new Date().toISOString() : null,
        })
        .eq("nonce", nonce)
        .select()
        .maybeSingle();
      fail("advancePayment", error);
      return data ? (normalizeAmount(data) as PaymentRecord) : null;
    },

    async recordEvent(params: {
      orderId?: string;
      type: string;
      payload: unknown;
      sigVerified?: boolean;
    }) {
      const { error } = await db.from("events").insert({
        order_id: params.orderId ?? null,
        type: params.type,
        payload: params.payload,
        sig_verified: params.sigVerified ?? false,
      });
      fail("recordEvent", error);
    },

    /** On-chain actions recorded for an order, oldest first — the inspector view. */
    async listPayments(orderId: string): Promise<Array<{
      kind: PaymentKind; status: string; tx_hash: string | null; chain: string | null; amount: string | null;
    }>> {
      const { data, error } = await db
        .from("payments")
        .select("kind, status, tx_hash, chain, amount")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true });
      fail("listPayments", error);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => normalizeAmount(r)) as never;
    },

    /** Most-recent orders — the marketplace's seller/host order lists. */
    async listOrders(limit = 50): Promise<OrderRecord[]> {
      const { data, error } = await db
        .from("orders")
        .select()
        .order("created_at", { ascending: false })
        .limit(limit);
      fail("listOrders", error);
      return ((data ?? []) as OrderRecord[]).map(normalizeOrder);
    },

    /** Off-chain signals recorded for an order (shipped, confirmed, dispute…), oldest first. */
    async listEvents(orderId: string): Promise<Array<{ type: string; payload: unknown; received_at: string }>> {
      const { data, error } = await db
        .from("events")
        .select("type, payload, received_at")
        .eq("order_id", orderId)
        .order("received_at", { ascending: true });
      fail("listEvents", error);
      return (data ?? []) as never;
    },

    async listEventsByType(type: string, limit = 10) {
      const { data, error } = await db
        .from("events")
        .select("order_id, type, payload, received_at")
        .eq("type", type)
        .order("received_at", { ascending: false })
        .limit(limit);
      fail("listEventsByType", error);
      return (data ?? []) as never;
    },

    /**
     * The batch reads. One query each, grouped in memory.
     *
     * An empty id list short-circuits: PostgREST would happily run `in.()` and
     * return nothing, but the round trip is pure waste on a board with no
     * orders — the state a fresh deployment is in.
     */
    async listEventsFor(orderIds: readonly string[]) {
      const out: Record<string, Array<{ type: string; payload: unknown; received_at: string }>> = {};
      for (const id of orderIds) out[id] = [];
      if (orderIds.length === 0) return out;

      const { data, error } = await db
        .from("events")
        .select("order_id, type, payload, received_at")
        .in("order_id", orderIds as string[])
        .order("received_at", { ascending: true });
      fail("listEventsFor", error);
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const id = row.order_id as string;
        // An event may be stored unattributed (a webhook we could not tie to an
        // order); `in` cannot return one, but a defensive skip costs nothing.
        out[id]?.push({ type: row.type as string, payload: row.payload, received_at: row.received_at as string });
      }
      return out;
    },

    async listPaymentsFor(orderIds: readonly string[]) {
      const out: Record<string, PaymentRecord[]> = {};
      for (const id of orderIds) out[id] = [];
      if (orderIds.length === 0) return out;

      const { data, error } = await db
        .from("payments")
        .select("order_id, kind, status, tx_hash, chain, amount")
        .in("order_id", orderIds as string[])
        .order("created_at", { ascending: true });
      fail("listPaymentsFor", error);
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        out[row.order_id as string]?.push(normalizeAmount(row) as never);
      }
      return out;
    },

    async listPayoutsFor(orderIds: readonly string[]) {
      const out: Record<string, PayoutInstruction | null> = {};
      for (const id of orderIds) out[id] = null;
      if (orderIds.length === 0) return out;

      const { data, error } = await db
        .from("orders")
        .select("id, payout")
        .in("id", orderIds as string[]);
      fail("listPayoutsFor", error);
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const wire = row.payout as PayoutInstructionWire | null | undefined;
        out[row.id as string] = wire ? fromPayoutWire(wire) : null;
      }
      return out;
    },

    /** Orders waiting on an external event — the reconciliation sweep. */
    async listPending(): Promise<OrderRecord[]> {
      const { data, error } = await db
        .from("orders")
        .select()
        .in("state", ["funding_pending", "refund_pending"]);
      fail("listPending", error);
      return ((data ?? []) as OrderRecord[]).map(normalizeOrder);
    },

    /**
     * Which order an on-chain tx belongs to.
     *
     * The payments table is the txHash→order index: every money move is recorded
     * there with its hash, so an inbound webhook that carries a txHash can be tied
     * back to the order that produced it. Returns null for a hash we never
     * recorded — a notification about a transaction that isn't ours, which must be
     * stored unattributed rather than forced onto some order.
     */
    async findOrderIdByTxHash(txHash: string): Promise<string | null> {
      const { data, error } = await db
        .from("payments")
        .select("order_id")
        .ilike("tx_hash", txHash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      fail("findOrderIdByTxHash", error);
      return (data?.order_id as string | undefined) ?? null;
    },

    /**
     * Persist the payout instruction emitted on release.
     *
     * It lives on the order rather than in process memory because the host
     * reads it later, from another request and possibly another instance — an
     * in-memory copy answers `null` after any restart, which reads as "no
     * payout was ever owed" rather than "this process forgot".
     *
     * The `MOCK` label is re-asserted by a CHECK constraint in the schema, so a
     * future caller cannot store an instruction that claims to be real.
     */
    async savePayout(orderId: string, payout: PayoutInstruction): Promise<void> {
      const { error } = await db
        .from("orders")
        .update({ payout: toPayoutWire(payout) })
        .eq("id", orderId);
      fail("savePayout", error);
    },

    async getPayout(orderId: string): Promise<PayoutInstruction | null> {
      const { data, error } = await db
        .from("orders")
        .select("payout")
        .eq("id", orderId)
        .maybeSingle();
      fail("getPayout", error);
      const wire = data?.payout as PayoutInstructionWire | null | undefined;
      return wire ? fromPayoutWire(wire) : null;
    },

    async recordCpnPayment(params: RecordCpnPaymentParams): Promise<CpnPaymentRecord> {
      const { data, error } = await db
        .from("cpn_payments")
        .insert({
          payment_id: params.paymentId,
          order_id: params.orderId ?? null,
          corridor: params.corridor,
          sender_address: params.senderAddress,
          signed_by: params.signedBy,
          source_minor: params.sourceMinor.toString(),
          source_currency: params.sourceCurrency,
          destination_minor: params.destinationMinor.toString(),
          destination_currency: params.destinationCurrency,
          destination_scale: params.destinationScale ?? 2,
          status: params.status,
          transaction_id: params.transactionId ?? null,
          ...(params.prepared === undefined ? {} : { prepared: params.prepared }),
        })
        .select()
        .single();
      fail("recordCpnPayment", error);
      return normalizeCpn(data as CpnPaymentRecord);
    },

    async setCpnPrepared(paymentId: string, prepared: unknown | null): Promise<void> {
      const { error } = await db
        .from("cpn_payments")
        .update({ prepared, updated_at: new Date().toISOString() })
        .eq("payment_id", paymentId);
      fail("setCpnPrepared", error);
    },

    async getCpnPayment(paymentId: string): Promise<CpnPaymentRecord | null> {
      const { data, error } = await db
        .from("cpn_payments").select().eq("payment_id", paymentId).maybeSingle();
      fail("getCpnPayment", error);
      return data ? normalizeCpn(data as CpnPaymentRecord) : null;
    },

    async advanceCpnPayment(
      paymentId: string,
      status: CpnPaymentState,
      patch: { transactionId?: string; failureReason?: string } = {},
    ): Promise<CpnPaymentRecord> {
      const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (patch.transactionId !== undefined) update.transaction_id = patch.transactionId;
      if (patch.failureReason !== undefined) update.failure_reason = patch.failureReason;

      const { data, error } = await db
        .from("cpn_payments").update(update).eq("payment_id", paymentId).select().single();
      fail(`advanceCpnPayment →${status}`, error);
      return normalizeCpn(data as CpnPaymentRecord);
    },

    async listCpnPayments(limit = 50): Promise<CpnPaymentRecord[]> {
      // Columns spelled out rather than `select()`: this list is polled by the
      // history panel, and `prepared` holds a whole EIP-712 payload that no
      // reader of the list ever looks at.
      const { data, error } = await db
        .from("cpn_payments")
        .select(
          "payment_id, order_id, corridor, sender_address, signed_by, source_minor, source_currency," +
            " destination_minor, destination_currency, destination_scale, status, transaction_id," +
            " failure_reason, created_at, updated_at",
        )
        .order("created_at", { ascending: false }).limit(limit);
      fail("listCpnPayments", error);
      // Through `unknown`: supabase-js infers the row type from the select
      // string as a literal, and a column list assembled by concatenation is
      // not one it can read.
      return ((data ?? []) as unknown as CpnPaymentRecord[]).map(normalizeCpn);
    },

    async deleteOrder(id: string) {
      const { error } = await db.from("orders").delete().eq("id", id);
      fail("deleteOrder", error);
    },
  };
}

export type { Address };
