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
  | "refund" | "reclaim" | "swap" | "rebate" | "bridge_back";

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

function normalizeAmount<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = { ...(row as Record<string, unknown>) };
  if (typeof out.amount === "number") out.amount = BigInt(out.amount).toString();
  return out as T;
}

export function createOrderStore(url: string, serviceKey: string) {
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
      if (!current) throw new Error(`order-store transition: order ${id} tidak ada`);

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

    /** Orders waiting on an external event — the reconciliation sweep. */
    async listPending(): Promise<OrderRecord[]> {
      const { data, error } = await db
        .from("orders")
        .select()
        .in("state", ["funding_pending", "refund_pending"]);
      fail("listPending", error);
      return ((data ?? []) as OrderRecord[]).map(normalizeOrder);
    },

    async deleteOrder(id: string) {
      const { error } = await db.from("orders").delete().eq("id", id);
      fail("deleteOrder", error);
    },
  };
}

export type OrderStore = ReturnType<typeof createOrderStore>;
export type { Address };
