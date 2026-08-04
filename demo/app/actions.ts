"use server";

import { getRivoKit } from "../lib/rivokit.server.ts";
import { payoutRailFor } from "../lib/cpn.server.ts";
import { policyFor, type Wedge } from "../../src/orchestrator/policy.ts";
import { toDestinationMinor, type PayoutTarget } from "../../src/payout/rail.ts";
import { assertUnlocked, assertWithinCap, CAP_TOKEN_MINOR } from "../lib/guard.server.ts";

export type PaymentRow = { kind: string; status: string; txHash: string | null; chain: string | null; amount: string | null };

/**
 * The fiat leg as the UI needs it.
 *
 * `scale` is carried rather than assumed. A MOCK instruction mirrors the EURC
 * it stands in for and so is 6-decimal; a live CPN payout is a real currency
 * amount at the rail's scale, 2 for EUR/USD. Formatting both with 1e6 — as this
 * demo did while only the mock existed — renders a €10.00 bank payout as €0.00.
 */
export type PayoutView = {
  kind: string;
  label: string;
  executed: boolean;
  reference: string | null;
  status: string | null;
  source: { currency: string; amountMinor: string; scale: number };
  target: { currency: string; amountMinor: string; scale: number; estimated: boolean };
  beneficiary: string;
  disclaimer: string;
} | null;

export type Snapshot = {
  orderId: string;
  state: string;
  priceEUR: string;
  usdcAmount: string | null;
  receivingChain: string;
  wedge: string;
  payoutTo: PayoutTarget;
  /** Why a stalled order stalled. Present on settlement_pending and failed. */
  failureReason: string | null;
  payments: PaymentRow[];
  payout: PayoutView;
};

export type ActionResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

/** What the UI needs to decide whether to offer the bank destination at all. */
export type PayoutOptions = { enabled: boolean; corridor: string; minEURMinor: string };

/**
 * The corridor's own floor, restated in euros.
 *
 * EUR/SEPA asks ~11 USDC and CPN refuses from the DESTINATION side, so the
 * threshold drifts with FX. €10 clears it with room to spare; below it
 * `createOrder` refuses the order outright, which is a worse first experience
 * than a disabled control that says why.
 */
const BANK_MIN_EUR_MINOR = 10_000_000n;

async function snapshot(orderId: string): Promise<Snapshot> {
  const { kit, store } = getRivoKit();
  const order = await kit.status(orderId);
  const payments = (await store.listPayments(orderId)).map((p) => ({
    kind: p.kind, status: p.status, txHash: p.tx_hash, chain: p.chain, amount: p.amount,
  }));
  const p = await kit.payoutFor(orderId);
  const payout: PayoutView = p
    ? {
        kind: p.kind,
        label: p.label,
        executed: p.executed,
        reference: p.reference?.paymentId ?? null,
        status: p.reference?.status ?? null,
        source: {
          currency: p.source.currency,
          amountMinor: p.source.amountMinor.toString(),
          scale: 6, // on-chain leg is always a 6-decimal stablecoin
        },
        target: {
          currency: p.target.currency,
          amountMinor: p.target.amountMinor.toString(),
          scale: p.target.scale,
          estimated: p.target.estimated,
        },
        beneficiary: p.beneficiary,
        disclaimer: p.disclaimer,
      }
    : null;
  return {
    orderId: order.id, state: order.state, priceEUR: order.priceEUR, usdcAmount: order.usdcAmount,
    receivingChain: order.receivingChain, wedge: order.wedge, payoutTo: order.payoutTo,
    failureReason: order.failureReason,
    payments, payout,
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

export async function payoutOptionsAction(): Promise<PayoutOptions> {
  const { payout } = getRivoKit();
  return {
    enabled: payout.enabled,
    corridor: payout.corridor,
    minEURMinor: BANK_MIN_EUR_MINOR.toString(),
  };
}

/* ---------------------------------------------------------------- estimates */

/**
 * One swap quote, cached, so the UI can price ANY typed amount without asking
 * the chain per keystroke.
 *
 * The wallet figure scales linearly — the swap's cost is a spread, so one probe
 * describes every size. `estimateSwap` is a live call against a rate-limited
 * RPC; quoting on every keystroke would exhaust it on a number that is
 * approximate by definition.
 */
export type FxProbe = { amountInMinor: string; amountOutMinor: string; bufferBps: number } | null;

const WALLET_BUFFER_BPS = 150; // SDK default, sized for swap slippage
const BANK_BUFFER_BPS = 400n; // what a bank order passes: CPN spread + four fees
const PROBE_TTL_MS = 60_000;

let probeCache: { at: number; probe: FxProbe } | null = null;

export async function fxProbeAction(): Promise<FxProbe> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.probe;
  const { kit, addresses } = getRivoKit();
  let probe: FxProbe = null;
  try {
    const q = await kit.estimateSwap({ address: addresses.buyer, amountInMinor: 10_000_000n });
    if (BigInt(q.amountOutMinor) > 0n) {
      probe = {
        amountInMinor: q.amountInMinor.toString(),
        amountOutMinor: q.amountOutMinor.toString(),
        bufferBps: WALLET_BUFFER_BPS,
      };
    }
  } catch {
    /* leave null — the UI shows the guaranteed euro price and no estimate */
  }
  probeCache = { at: Date.now(), probe };
  return probe;
}

/**
 * What a bank order of this size would cost, asked of the RAIL.
 *
 * Deliberately NOT scaled from a probe the way the wallet figure is. CPN's fees
 * are partly FLAT — `BFI_TRANSACTION_FEE` was the same 25.018594 USDC on a
 * 62 USDC payment and on a 42 USDC quote — so a linear estimate understates
 * small orders badly and would be worse than showing nothing.
 *
 * The rail prices in the DESTINATION's scale (fiat cents), not the 6-decimal
 * minor units money is carried in everywhere else. Handing it the 6-decimal
 * figure asks for a payout 10 000× too large and the quote comes back looking
 * plausible.
 */
export async function bankEstimateAction(priceEurMinorStr: string): Promise<string | null> {
  const { payout } = getRivoKit();
  if (!payout.enabled) return null;
  if (BigInt(priceEurMinorStr) < BANK_MIN_EUR_MINOR) return null;
  try {
    const rail = payoutRailFor(payout.corridor);
    if (!rail.estimate) return null;
    const limits = await rail.limits();
    const destinationMinor = toDestinationMinor(BigInt(priceEurMinorStr), limits.destinationScale);
    const { requiredSourceMinor } = await rail.estimate(destinationMinor);
    return (requiredSourceMinor + (requiredSourceMinor * BANK_BUFFER_BPS) / 10_000n).toString();
  } catch {
    return null; // corridor unreachable or below its own minimum
  }
}

/* ------------------------------------------------------------------ payer */

/** The server-signed demo buyer, used when no browser wallet is connected. */
export async function demoBuyerAction(): Promise<string> {
  return getRivoKit().addresses.buyer;
}

/** Arc USDC balance of a connected wallet — this demo funds from Arc directly. */
export async function arcUsdcAction(address: string): Promise<string | null> {
  try {
    return await getRivoKit().addrArcUsdc(address);
  } catch {
    return null;
  }
}

export type AuthTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: {
    from: string; to: string; value: string;
    validAfter: string; validBefore: string; nonce: string;
  };
};

/** The ERC-3009 authorization for a connected wallet to sign in its own browser. */
export async function authTypedDataAction(
  orderId: string,
): Promise<{ ok: true; typedData: AuthTypedData } | { ok: false; error: string }> {
  try {
    const td = await getRivoKit().authTypedDataFor(orderId);
    return {
      ok: true,
      typedData: {
        domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as string },
        types: td.types as AuthTypedData["types"],
        primaryType: td.primaryType,
        message: {
          from: td.message.from, to: td.message.to,
          value: td.message.value.toString(),
          validAfter: td.message.validAfter.toString(),
          validBefore: td.message.validBefore.toString(),
          nonce: td.message.nonce,
        },
      },
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/**
 * Connected-wallet fund: the buyer signed the ERC-3009 authorization themselves
 * and the operator only relays it (gasless). No server key touches this order's
 * funding — which is the property the demo exists to show.
 *
 * The USDC must already be on Arc. The cross-chain rails that would bring it
 * there live in the marketplace demo; this page keeps one step per call.
 */
export async function paySignedAction(orderId: string, signature: string): Promise<ActionResult> {
  return wrap(async () => {
    await getRivoKit().kit.fund(orderId, { signature: signature as `0x${string}` });
    return orderId;
  });
}

/**
 * Buyer: create an order for €priceEUR on a wedge, bound for a wallet or a bank.
 *
 * The destination is decided HERE and nowhere else — it picks the receiver, the
 * buffer, and whether `release()` runs a swap or an off-ramp. Two details are
 * not cosmetic:
 *
 *   receiver — a bank order's captured USDC is what the off-ramp spends, so it
 *     must land on the wallet that signs the Permit2 intent (the seller's).
 *     Paying the merchant would leave the payout with nothing to pull from.
 *   bufferBps — the default 150 bps is sized for swap slippage. A bank order
 *     has to absorb CPN's spread and its four fees between checkout and
 *     release, or it stalls in `settlement_pending` on an ordinary rate move.
 */
export async function createOrderAction(
  priceEurMinorStr: string,
  wedge: Wedge,
  payoutTo: PayoutTarget = "wallet",
  payer?: string,
): Promise<ActionResult> {
  return wrap(async () => {
    // Everything downstream of an order spends something — the buyer's USDC at
    // fund, the operator's gas at every relay, the seller's USDC at a bank
    // payout. Gate and cap it at the point it is created, where refusing is
    // still free.
    await assertUnlocked("Creating an order");
    assertWithinCap(BigInt(priceEurMinorStr), CAP_TOKEN_MINOR, "Order price");

    const { kit, store, addresses, payout } = getRivoKit();

    if (payoutTo === "bank") {
      if (!payout.enabled) {
        throw new Error(
          "Bank payout is not wired — CIRCLE_CPN_KEY and RELAYER_PRIVATE_KEY are needed. Settle to a wallet instead.",
        );
      }
      if (BigInt(priceEurMinorStr) < BANK_MIN_EUR_MINOR) {
        throw new Error(
          `The ${payout.corridor} corridor will not take an order this small. ` +
            `Use €${(Number(BANK_MIN_EUR_MINOR) / 1e6).toFixed(2)} or more for a bank payout.`,
        );
      }
    }

    const receiver = payoutTo === "bank" ? payout.receiver! : addresses.merchant;

    const order = await kit.createOrder({
      payer: (payer ?? addresses.buyer) as `0x${string}`,
      receiver: receiver as `0x${string}`,
      priceEURMinor: BigInt(priceEurMinorStr),
      receivingChain: "Arc_Testnet",
      wedge,
      payoutTo,
      ...(payoutTo === "bank" ? { bufferBps: 400 } : {}),
    });

    // Mark where this order came from. Without it an SDK order is identifiable
    // only by the ABSENCE of the marketplace's `mp.order` event — which is
    // guessing from missing data, and stops working the moment anything else
    // writes orders. Also records who signed, since that is the one thing the
    // order row itself cannot show: `payer` looks identical either way.
    await store.recordEvent({
      orderId: order.id,
      type: "sdk.order",
      payload: { payoutTo, signer: payer ? "wallet" : "demo_key", ...(payer ? { payer } : {}) },
    });
    return order.id;
  });
}

export type OrderSummary = {
  id: string;
  state: string;
  priceEUR: string;
  payoutTo: string;
  createdAt: string;
  origin: "sdk" | "other";
  signer: string | null;
};

/**
 * Recent orders, newest first.
 *
 * The page kept its only record of an order in React state, so a refresh lost
 * it while the row sat in Postgres the whole time. Nothing was ever unrecorded
 * — it was unrendered.
 */
export async function listOrdersAction(limit = 8): Promise<OrderSummary[]> {
  const { store } = getRivoKit();
  const orders = await store.listOrders(limit);
  return Promise.all(orders.map(async (o) => {
    const events = await store.listEvents(o.id);
    const mark = events.find((e) => e.type === "sdk.order")?.payload as
      | { signer?: string } | undefined;
    return {
      id: o.id,
      state: o.state,
      priceEUR: o.price_eur.toString(),
      payoutTo: o.payout_to ?? "wallet",
      createdAt: o.created_at,
      origin: mark ? "sdk" : "other",
      signer: mark?.signer ?? null,
    };
  }));
}

/** Buyer: fund the escrow (gasless authorize). Minutes — operator relay. */
export async function fundAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    await assertUnlocked("Funding an order");
    await getRivoKit().kit.fund(orderId);
    return orderId;
  });
}

/**
 * Seller: release.
 *
 * Wallet order → capture, floored swap to EURC, MOCK payout instruction.
 * Bank order   → capture, CPN quote pinned to priceEUR, broadcast. IRREVERSIBLE.
 *
 * The proof follows the wedge rather than being hardcoded: `digital_goods`
 * expects `access_granted`, the B2B wedges expect `milestone`. Sending the
 * wrong one is refused by `checkReleaseProof`, which is the behaviour worth
 * showing — RivoKit checks that the claimed proof FITS the wedge, and never
 * that the milestone really happened.
 */
export async function releaseAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    // Capture is irreversible for the escrow, and on a bank order this call
    // reaches all the way to a broadcast.
    await assertUnlocked("Releasing an order");
    const { kit } = getRivoKit();
    const order = await kit.status(orderId);
    const kind = policyFor(order.wedge as Wedge).expectedProof[0]!;
    await kit.release(orderId, { kind, ref: `demo-${kind}` });
    return orderId;
  });
}

/**
 * Resume an order that was captured but never reached its currency.
 *
 * The escrow is already empty here, so this must NOT go through `release()` —
 * that would capture a second time. `retrySettlement` swaps again on the wallet
 * path and re-quotes on the bank path, and touches the escrow on neither.
 */
export async function retrySettlementAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    await assertUnlocked("Retrying settlement");
    await getRivoKit().kit.retrySettlement(orderId);
    return orderId;
  });
}

/** Buyer: refund — void/refund back to the payer (receivingChain = Arc here). */
export async function refundAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    // A post-capture refund pulls from the OPERATOR's own balance.
    await assertUnlocked("Refunding an order");
    await getRivoKit().kit.refund(orderId);
    return orderId;
  });
}

/**
 * Read the payout rail again and settle the stored row.
 *
 * A broadcast returns BEFORE its transfer is mined, so the Arc hash does not
 * exist at write time and the row is born `pending` — the database is right to
 * refuse a confirmation without one. This second read is what turns it
 * `confirmed`, and it is the same path a webhook takes. Without it the demo
 * would show a permanently pending payout and look broken while being correct.
 */
export async function refreshPayoutAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => {
    await getRivoKit().kit.refreshPayout(orderId);
    return orderId;
  });
}

/** Poll the current order state + payments + payout. */
export async function snapshotAction(orderId: string): Promise<ActionResult> {
  return wrap(async () => orderId);
}
