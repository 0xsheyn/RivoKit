"use server";

import { getRivoKit } from "../lib/rivokit.server.ts";
import type { Wedge } from "../../src/orchestrator/policy.ts";

export type PaymentRow = { kind: string; status: string; txHash: string | null; chain: string | null; amount: string | null };
export type PayoutView = { label: string; executed: boolean; sourceAmount: string; targetAmount: string; beneficiary: string; disclaimer: string } | null;

export type Snapshot = {
  orderId: string;
  state: string;
  priceEUR: string;
  usdcAmount: string | null;
  receivingChain: string;
  wedge: string;
  payments: PaymentRow[];
  payout: PayoutView;
};

export type ActionResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

async function snapshot(orderId: string): Promise<Snapshot> {
  const { kit, store } = getRivoKit();
  const order = await kit.status(orderId);
  const payments = (await store.listPayments(orderId)).map((p) => ({
    kind: p.kind, status: p.status, txHash: p.tx_hash, chain: p.chain, amount: p.amount,
  }));
  const p = kit.payoutFor(orderId);
  const payout: PayoutView = p
    ? {
        label: p.label, executed: p.executed,
        sourceAmount: p.source.amountMinor.toString(), targetAmount: p.target.amountMinor.toString(),
        beneficiary: p.beneficiary, disclaimer: p.disclaimer,
      }
    : null;
  return {
    orderId: order.id, state: order.state, priceEUR: order.priceEUR, usdcAmount: order.usdcAmount,
    receivingChain: order.receivingChain, wedge: order.wedge, payments, payout,
  };
}

const wrap = async (fn: () => Promise<string>): Promise<ActionResult> => {
  try {
    const orderId = await fn();
    return { ok: true, snapshot: await snapshot(orderId) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
};

/** Buyer: create an order for €priceEUR on a wedge. Fast (quote + store). */
export async function createOrderAction(priceEurMinorStr: string, wedge: Wedge): Promise<ActionResult> {
  return wrap(async () => {
    const { kit, addresses } = getRivoKit();
    const order = await kit.createOrder({
      payer: addresses.buyer as `0x${string}`,
      receiver: addresses.merchant as `0x${string}`,
      priceEURMinor: BigInt(priceEurMinorStr),
      receivingChain: "Arc_Testnet",
      wedge,
    });
    return order.id;
  });
}

/** Buyer: fund the escrow (gasless authorize). Minutes — operator relay. */
export async function fundAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    await getRivoKit().kit.fund(orderId);
    return orderId;
  });
}

/** Seller: release — capture, swap to floored EURC, emit a MOCK payout. */
export async function releaseAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    await getRivoKit().kit.release(orderId, { kind: "access_granted", ref: "demo-license" });
    return orderId;
  });
}

/** Buyer: refund — void/refund back to the payer (receivingChain = Arc here). */
export async function refundAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    await getRivoKit().kit.refund(orderId);
    return orderId;
  });
}

/** Poll the current order state + payments + payout. */
export async function snapshotAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => orderId);
}
