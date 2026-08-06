/**
 * Server-only CPN off-ramp wiring for the demo — the multi-currency seller
 * cash-out that ENRICHES RivoKit (it does not replace the EURC-floor/StableFX
 * settlement, which stays for EUR/USD guarantees).
 *
 * CPN takes USDC and pays out local fiat directly, so one USDC balance reaches
 * many currencies StableFX + Circle Mint cannot: EUR/SEPA, BRL/PIX, MXN/SPEI,
 * USD/WIRE — each with its own beneficiary + travel-rule fields (verified live).
 * A ramp is created and cached per corridor.
 *
 * Reads CIRCLE_CPN_KEY (server-only) — never import from a client component;
 * all calls run in server actions (demo/app/ramp.actions.ts). The demo signs on
 * the seller's behalf with a testnet key; in production the seller signs in
 * their own wallet.
 */
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installCircleDnsPinning } from "../../src/lib/circle-dns.ts";
import { sleep } from "../../src/lib/rpc.ts";
import { ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../../src/constants/arc.ts";
import { createCpnRamp, type CpnRamp } from "../../src/ramp/cpn-ramp.ts";
import { signPaymentIntent } from "../../src/ramp/cpn-sign.ts";
import { createCpnPayoutRail } from "../../src/payout/cpn-payout.ts";
import type { PayoutRail } from "../../src/payout/rail.ts";
import { reconcilePaymentStatus, type CpnPaymentState } from "../../src/ramp/cpn-state.ts";
import { fromDecimalStringScaled } from "../../src/settlement-fx/units.ts";
import { createOrderStore, type CpnPaymentRecord, type OrderStore } from "../../src/orchestrator/order-store.ts";
import type { CpnPayment, CpnQuote, CpnTransaction } from "../../src/ramp/cpn-client.ts";
import type { CpnFieldValue } from "../../src/ramp/cpn-encrypt.ts";
import { loadRootEnv } from "../../scripts/lib/env.mjs";

loadRootEnv();
installCircleDnsPinning();

// ── Corridors ──────────────────────────────────────────────────────────
//
// Beneficiary + travel-rule requirements differ per payout rail; these were
// read live from GET /v1/cpn/payments/requirements per corridor. Demo values.

// Each address's postalCode is validated against its own country's format, and
// the beneficiary must sit in the destination country — so the beneficiary
// address is per-corridor while the originator (OFI) stays US.
const ORIGINATOR_ADDR = { street: "456 Madison Ave", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" };
const buildTravelRule = (beneficiaryAddr: Record<string, string>, originatorName = "Rivo Co"): CpnFieldValue[] => [
  { name: "ORIGINATOR_NAME", value: originatorName },
  { name: "BENEFICIARY_NAME", value: "Acme Co" },
  { name: "ORIGINATOR_ADDRESS", value: ORIGINATOR_ADDR },
  { name: "BENEFICIARY_ADDRESS", value: beneficiaryAddr },
  { name: "ORIGINATOR_ACCOUNT_NUMBER", value: "US1234567890" },
  { name: "ORIGINATOR_FINANCIAL_INSTITUTION_NAME", value: "Rivo Bank" },
  { name: "ORIGINATOR_FINANCIAL_INSTITUTION_ADDRESS", value: ORIGINATOR_ADDR },
];

/** UI-safe corridor summary. */
export type CorridorInfo = {
  key: string; label: string; currency: string; method: string; minUsdc: number;
  /** Corridors this build phase targets are selectable; the rest are on the
   *  roadmap and shown but not offered. */
  roadmap: boolean;
};

type Corridor = CorridorInfo & {
  country: string;
  /** Beneficiary postal address — postalCode must match `country`'s format. */
  address: Record<string, string>;
  beneficiary: CpnFieldValue[];
  /** Fields this corridor adds on top of the base travel rule (e.g. MX needs a national ID). */
  extraTravelRule?: CpnFieldValue[];
};

const CORRIDORS: Record<string, Corridor> = {
  // `minUsdc` is a UI guardrail, not the real rule. CPN rejects amounts with
  // 290100 "outside our supported limits" against the DESTINATION side, so the
  // USDC figure that clears drifts with FX: 11 USDC (~9.4 EUR) is refused while
  // 12 USDC (10.31 EUR) is accepted — verified live 2026-07-28. Keep these a
  // little above the observed floor; the API stays the authority.
  // Order is the UI's order: the two corridors this phase targets first.
  "EUR-SEPA": {
    key: "EUR-SEPA", label: "🇪🇺 EUR · SEPA", currency: "EUR", method: "SEPA", minUsdc: 12, country: "FR",
    roadmap: false,
    address: { street: "1 Rue de Rivoli", city: "Paris", stateProvince: "IDF", country: "FR", postalCode: "75001" },
    beneficiary: [
      { name: "IBAN", value: "FR7630006000011234567890189" },
      { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
    ],
  },
  "USD-WIRE": {
    key: "USD-WIRE", label: "🌍 USD · WIRE", currency: "USD", method: "WIRE", minUsdc: 61, country: "US",
    roadmap: false,
    address: { street: "5th Avenue 1", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" },
    beneficiary: [
      { name: "BANK_NAME", value: "First National Bank" },
      { name: "SWIFT_CODE", value: "FNBKUS33" },
      { name: "BANK_COUNTRY", value: "US" },
      { name: "ACCOUNT_NUMBER", value: "1234567890" },
      { name: "RECIPIENT_LEGAL_NAME", value: "Acme LLC" },
    ],
  },
  "BRL-PIX": {
    key: "BRL-PIX", label: "🇧🇷 BRL · PIX", currency: "BRL", method: "PIX", minUsdc: 10, country: "BR",
    roadmap: true,
    address: { street: "Av. Paulista 1000", city: "Sao Paulo", stateProvince: "SP", country: "BR", postalCode: "01310-100" },
    beneficiary: [
      { name: "RECIPIENT_ID_NUMBER", value: "11222333000181" },
      { name: "RECIPIENT_EVP", value: "123e4567-e89b-12d3-a456-426614174000" },
    ],
  },
  "MXN-SPEI": {
    key: "MXN-SPEI", label: "🇲🇽 MXN · SPEI", currency: "MXN", method: "SPEI", minUsdc: 11, country: "MX",
    roadmap: true,
    address: { street: "Av. Reforma 100", city: "Mexico City", stateProvince: "CDMX", country: "MX", postalCode: "06600" },
    beneficiary: [{ name: "CLABE", value: "032180000118359719" }],
    extraTravelRule: [{ name: "BENEFICIARY_NATIONAL_IDENTIFICATION_NUMBER", value: "AAA010101AAA" }],
  },
};
const DEFAULT_CORRIDOR = "EUR-SEPA";

/** The corridors the seller can cash out to, in the order the UI shows them. */
export function corridorList(): CorridorInfo[] {
  return Object.values(CORRIDORS).map(({ key, label, currency, method, minUsdc, roadmap }) => ({
    key, label, currency, method, minUsdc, roadmap,
  }));
}

let storeSingleton: OrderStore | null = null;
/**
 * Own store handle. This module is driven by server actions that never go
 * through the RivoKit facade, and a cash-out is not part of an order — so it
 * reaches persistence directly rather than borrowing the facade's wiring.
 */
function cpnStore(): OrderStore {
  storeSingleton ??= createOrderStore(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SECRET_KEY as string,
  );
  return storeSingleton;
}

/**
 * Past cash-outs, newest first.
 *
 * Read from the store rather than from CPN: the stored row is what the webhook
 * and the polling fallback both advance, so it is the record the demo actually
 * acts on — and it survives a restart, or a second serverless instance, which
 * no in-process copy does.
 */
export function listCashouts(limit = 10): Promise<CpnPaymentRecord[]> {
  return cpnStore().listCpnPayments(limit);
}

const rampCache = new Map<string, CpnRamp>();

function corridorFor(corridorKey: string): Corridor {
  return CORRIDORS[corridorKey] ?? CORRIDORS[DEFAULT_CORRIDOR]!;
}

function getRampFor(corridor: Corridor): CpnRamp {
  const apiKey = process.env.CIRCLE_CPN_KEY;
  if (!apiKey) throw new Error("CIRCLE_CPN_KEY kosong — cek .env.local (sync: node scripts/sync-env.mjs)");
  let ramp = rampCache.get(corridor.key);
  if (!ramp) {
    ramp = createCpnRamp({
      apiKey,
      corridor: {
        senderType: "BUSINESS", recipientType: "BUSINESS", senderCountry: "US",
        destinationCountry: corridor.country, blockchain: "ARC-TESTNET", paymentMethodType: corridor.method,
        sourceCurrency: "USDC", destinationCurrency: corridor.currency,
      },
    });
    rampCache.set(corridor.key, ramp);
  }
  return ramp;
}

/** Default (EUR) ramp — kept for the standalone quote action. */
export function getCpnRamp(): CpnRamp {
  return getRampFor(corridorFor(DEFAULT_CORRIDOR));
}

// ── Seller wallet & payment flow ───────────────────────────────────────

type PreparedEntry = { transaction: CpnTransaction; corridorKey: string };

/**
 * Prepared transactions held between prepare and broadcast, keyed by paymentId.
 *
 * A CACHE, not the record. It used to be the record, and that was correct for
 * exactly one deployment shape: one long-lived process. Prepare and broadcast
 * are two requests, and on a serverless host they are two INSTANCES — so the
 * Map the broadcast reads is very often not the Map the prepare wrote. The
 * failure was reported as "the server restarted", which is not what happened
 * and sent the reader looking in the wrong place; what it left behind was a
 * `cpn_payments` row stuck at CREATED with no way forward.
 *
 * The row carries the intent now (`cpn_payments.prepared`). This stays because
 * a same-instance broadcast is the common case and a database round trip inside
 * a 30–60 second quote window is worth skipping.
 */
const preparedTx = new Map<string, PreparedEntry>();

/** The prepared intent, from this process if it has it and from the row if not. */
async function loadPrepared(paymentId: string): Promise<PreparedEntry | null> {
  const hot = preparedTx.get(paymentId);
  if (hot) return hot;

  const row = await cpnStore().getCpnPayment(paymentId);
  const stored = row?.prepared as PreparedEntry | null | undefined;
  // A row whose `prepared` is null is not an error: it is a payment that has
  // already been broadcast. The caller's message has to cover both.
  if (!stored?.transaction) return null;
  preparedTx.set(paymentId, stored);
  return stored;
}

/**
 * Drop the intent once it has been broadcast — from memory AND from the row.
 *
 * Never throws. The broadcast is irreversible and has already happened by the
 * time this runs; failing here would report a payment that CPN is processing as
 * an error, which is the one thing this path must not do.
 */
async function forgetPrepared(paymentId: string): Promise<void> {
  preparedTx.delete(paymentId);
  try {
    await cpnStore().setCpnPrepared(paymentId, null);
  } catch (e) {
    console.warn(`[cpn] prepared intent for ${paymentId} not cleared: ${String((e as Error).message)}`);
  }
}

// The public Arc RPC rate-limits hard; rotate across all endpoints so a single
// slow host can't stall an approve or a receipt wait (a hung broadcast).
const arcTransport = () => fallback(ARC_TESTNET_RPC_FALLBACKS.map((u) => http(u)));

/**
 * The SELLER's wallet — the funds owner who off-ramps. In the demo a dedicated
 * testnet EOA stands in for the seller; in production the seller signs in their
 * own wallet and `ramp.submit` takes any Account.
 *
 * This used to read `RELAYER_PRIVATE_KEY`, which was misleading: that key never
 * relayed anything. Every escrow call is relayed by the Circle operator wallet
 * (`OPERATOR_WALLET_ID`), and the key's only job — here and in every script that
 * touched it — was to BE the seller. It is `SELLER_PRIVATE_KEY` now, and the two
 * roles are separate wallets. Deliberately no fallback to the old name: a
 * fallback would quietly keep signing with the wallet you meant to retire.
 */
function getSellerSigner() {
  const pk = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("SELLER_PRIVATE_KEY (the demo seller wallet) is empty — check .env.local");
  return privateKeyToAccount(pk);
}

/** The seller's on-chain USDC balance on Arc — the accumulated proceeds to cash out. */
export async function sellerInfo(): Promise<{ address: string; usdcMinor: string }> {
  const signer = getSellerSigner();
  const pub = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
  const usdc = await pub.readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
  });
  return { address: signer.address, usdcMinor: usdc.toString() };
}

/**
 * Quote + create payment + create transaction for a corridor. No broadcast.
 *
 * `sellerAddress` is who the intent will be signed BY and refunded TO. Default
 * is the demo's server-held seller key; pass a connected wallet address to
 * prepare an intent only that wallet can sign. It has to be decided here, not
 * at broadcast: the sender address is baked into the payment and into the
 * Permit2 message, so an intent prepared for one address cannot later be signed
 * by another.
 */
export async function preparePayment(
  sourceAmountUsdc: string,
  corridorKey: string,
  sellerAddress?: string,
): Promise<{
  quote: CpnQuote;
  fees: { total: { amount: string; currency: string }; byType: Record<string, string> };
  spreadBps: number;
  payment: CpnPayment;
  transaction: CpnTransaction;
}> {
  const corridor = corridorFor(corridorKey);
  const ramp = getRampFor(corridor);
  const sender = sellerAddress ?? getSellerSigner().address;
  const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: sourceAmountUsdc });
  const { payment, transaction } = await ramp.prepare({
    quote,
    travelRule: [...buildTravelRule(corridor.address), ...(corridor.extraTravelRule ?? [])],
    beneficiaryAccount: corridor.beneficiary,
    senderAddress: sender,
    refundAddress: sender,
    useCase: "B2B",
    reasonForPayment: "PMT001",
    customerRefId: `demo-${quote.id.slice(0, 8)}`,
    // Reaches the beneficiary's bank statement memo — unlike `customerRefId`,
    // which never leaves Circle. It is the only string a real recipient could
    // use to recognise this credit, so it carries the payment's own handle.
    refCode: `RIVO-${quote.id.slice(0, 8)}`,
  });
  const prepared: PreparedEntry = { transaction, corridorKey: corridor.key };
  preparedTx.set(payment.id, prepared);

  // Persist the cash-out now, not after broadcasting. CPN can report on it
  // (RFI, delay, failure) from the moment the payment exists, and a webhook
  // about a payment we never stored is dropped as unknown.
  //
  // The intent rides along in the same write: the broadcast that needs it is a
  // separate request, and on Vercel a separate process.
  await cpnStore().recordCpnPayment({
    prepared,
    paymentId: payment.id,
    corridor: corridor.key,
    senderAddress: sender,
    signedBy: sellerAddress ? "wallet" : "server",
    sourceMinor: fromDecimalStringScaled(quote.sourceAmount.amount, 6),
    sourceCurrency: quote.sourceAmount.currency,
    destinationMinor: fromDecimalStringScaled(quote.destinationAmount.amount, 2),
    destinationCurrency: quote.destinationAmount.currency,
    status: (payment.status as CpnPaymentState) ?? "CREATED",
    transactionId: transaction.id,
  });

  return { quote, fees, spreadBps, payment, transaction };
}

/**
 * Write an observed status onto the stored cash-out, forward-only.
 *
 * The POLL reducer, not the webhook one. That distinction is the whole content
 * of this function, and getting it wrong is what left every released payout
 * showing `created` in the history while the order it belonged to was already
 * `paid_out`: this used to translate the polled status into the webhook it
 * would have arrived as and hand it to `applyPaymentEvent`, which correctly
 * refuses `CREATED → COMPLETED` because a single EVENT cannot cross two edges.
 * A poll is not an event — it is "this is where the payment is now", and the
 * notifications in between were simply never delivered (this demo has no
 * webhook endpoint at all). `reconcilePaymentStatus` allows that jump and still
 * refuses the two things that would lose information: going backwards, and
 * leaving a terminal state.
 */
async function persistStatus(paymentId: string, status: string): Promise<void> {
  const store = cpnStore();
  const current = await store.getCpnPayment(paymentId);
  if (!current) return;
  const outcome = reconcilePaymentStatus(current.status, status);
  if (outcome.changed) await store.advanceCpnPayment(paymentId, outcome.state);
}

/**
 * Said once, so both broadcast paths report the same thing.
 *
 * Deliberately no longer blames a restart: with the intent on the row, the two
 * ways to get here are a payment id that was never prepared, and one whose
 * intent has already gone out. Neither is recoverable by trying again — a new
 * quote is, which is what this asks for.
 */
const PREPARED_GONE =
  "No intent to broadcast for this payment — it was never prepared, or it has already been broadcast. Prepare a new cash-out.";

/** Ensure Permit2 can pull at least `amountMinor` USDC from the seller on Arc. */
async function ensureAllowance(amountMinor: bigint): Promise<void> {
  const signer = getSellerSigner();
  const pub = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
  const allowance = await pub.readContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [signer.address, PERMIT2_ADDRESS],
  });
  if (allowance >= amountMinor) return;
  const wallet = createWalletClient({ account: signer, chain: arcTestnet, transport: arcTransport() });
  const hash = await wallet.writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, amountMinor],
  });
  await pub.waitForTransactionReceipt({ hash });
}

/**
 * Sign the prepared intent and BROADCAST — irreversible. Ensures the Permit2
 * allowance first, then follows the payment lifecycle to a terminal status.
 */
export async function broadcastPayment(paymentId: string): Promise<{
  transactionId: string;
  submittedStatus: string;
  lifecycle: string[];
  finalStatus: string;
}> {
  const entry = await loadPrepared(paymentId);
  if (!entry) throw new Error(PREPARED_GONE);
  const ramp = getRampFor(corridorFor(entry.corridorKey));
  const signer = getSellerSigner();

  const permitAmount = BigInt((entry.transaction.messageToBeSigned.message as any)?.permitted?.amount ?? 0);
  await ensureAllowance(permitAmount > 0n ? permitAmount : 20_000_000n);

  const submitted = await ramp.submit({ paymentId, transaction: entry.transaction }, signer);
  await forgetPrepared(paymentId);

  const lifecycle: string[] = [];
  let last = "";
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    const p = await ramp.status(paymentId);
    if (p.status !== last) {
      lifecycle.push(p.status);
      last = p.status;
      // Polling is the fallback, not the source of truth — webhooks drive this
      // record too. Writing what we just observed keeps the stored state honest
      // even with no webhook endpoint registered (the demo has none).
      await persistStatus(paymentId, p.status);
    }
    if (last === "COMPLETED" || last === "FAILED") break;
  }
  return { transactionId: submitted.id, submittedStatus: submitted.status, lifecycle, finalStatus: last };
}

/**
 * Broadcast an intent the SELLER signed in their own wallet — IRREVERSIBLE.
 *
 * No server key touches this path. The signature arrives from the browser, and
 * the Permit2 allowance is the wallet's own transaction, so the only thing the
 * server contributes is the CPN API key (which cannot move funds by itself).
 * That is the whole point: the wallet holding the USDC is the wallet
 * authorizing it to leave.
 */
export async function broadcastSignedPayment(paymentId: string, signature: Hex): Promise<{
  transactionId: string;
  submittedStatus: string;
  lifecycle: string[];
  finalStatus: string;
}> {
  const entry = await loadPrepared(paymentId);
  if (!entry) throw new Error(PREPARED_GONE);
  const ramp = getRampFor(corridorFor(entry.corridorKey));

  const submitted = await ramp.submitSigned({ paymentId, transaction: entry.transaction }, signature);
  await forgetPrepared(paymentId);

  const lifecycle: string[] = [];
  let last = "";
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    const p = await ramp.status(paymentId);
    if (p.status !== last) {
      lifecycle.push(p.status);
      last = p.status;
      // Polling is the fallback, not the source of truth — webhooks drive this
      // record too. Writing what we just observed keeps the stored state honest
      // even with no webhook endpoint registered (the demo has none).
      await persistStatus(paymentId, p.status);
    }
    if (last === "COMPLETED" || last === "FAILED") break;
  }
  return { transactionId: submitted.id, submittedStatus: submitted.status, lifecycle, finalStatus: last };
}

// ── The same corridor, as a RivoKit payout rail ────────────────────────

/**
 * Expose this corridor as a `PayoutRail` so `release()` can drive it.
 *
 * Everything a rail needs already lives in this module — the corridor, the
 * beneficiary and travel-rule fields, the seller's signer, the Permit2
 * allowance helper — so this composes them rather than restating them. A second
 * copy of the travel-rule block would be a second thing to keep correct.
 *
 * The sender is the demo seller's EOA, which is also who bank-bound orders name
 * as `receiver`: capture lands there, Permit2 pulls from there, and that wallet
 * signs the intent. In production the seller signs in their own wallet and this
 * is where `signIntent` would reach for it instead.
 */
export function payoutRailFor(corridorKey: string): PayoutRail {
  const corridor = corridorFor(corridorKey);
  const signer = getSellerSigner();
  return recordingRail(
    createCpnPayoutRail({
      ramp: getRampFor(corridor),
      corridor: corridor.key,
      destinationCountry: corridor.country,
      senderAddress: signer.address,
      details: () => ({
        travelRule: [...buildTravelRule(corridor.address), ...(corridor.extraTravelRule ?? [])],
        beneficiaryAccount: corridor.beneficiary,
        useCase: "B2B",
        reasonForPayment: "PMT001",
      }),
      signIntent: (message) => signPaymentIntent(signer, message),
      ensureAllowance,
    }),
    corridor,
    signer.address,
  );
}

/**
 * The status a freshly broadcast payout is stored with.
 *
 * `PayoutSubmission.status` is "the rail's own status word", and for CPN that
 * word comes from `submitTransaction` — which reports the TRANSACTION
 * (`BROADCASTED`), not the PAYMENT. `cpn_payments.status` only accepts the five
 * payment states, so writing the submission's word straight through violates
 * `cpn_payments_status_check` and the row is never created. That failure is
 * silent by design here (see `submit` below), which is exactly what makes it
 * worth guarding against rather than trusting.
 *
 * So: use the word only if it IS a payment state — a different rail may well
 * report one — and otherwise fall back to `CREATED`, the state a CPN payment is
 * actually in at broadcast. The forward-only reducer takes it from there.
 */
function initialPaymentState(railWord: string): CpnPaymentState {
  const states: readonly string[] = [
    "CREATED", "CRYPTO_FUNDS_PENDING", "FIAT_PAYMENT_INITIATED", "COMPLETED", "FAILED",
  ];
  return states.includes(railWord) ? (railWord as CpnPaymentState) : "CREATED";
}

/**
 * Wrap a rail so the payouts `release()` broadcasts land in `cpn_payments` —
 * the same table the manual cash-out writes and the history panel reads.
 *
 * WHY A DECORATOR AND NOT A CHANGE TO THE SDK
 *
 * `cpn_payments` is the DEMO's ledger of CPN activity, not RivoKit's. The SDK
 * already records a payout where it belongs: on the order, as a payout
 * instruction plus `payout`/`rebate` ledger rows. Teaching it to also write a
 * demo table would put a host's bookkeeping inside the library. The rail is the
 * host's own code, so this is where the host's ledger gets written.
 *
 * WHY IT MATTERS AT ALL
 *
 * Without it a seller has no way to see that an order actually reached their
 * bank: the payment exists at CPN and on the order, but the one screen that
 * lists CPN payments would show only the cash-outs someone triggered by hand.
 * The two paths are equally real payouts and belong in one list.
 *
 * `order_id` is what tells them apart afterwards — the manual cash-out never
 * sets it, so a row that has one came from a release. The UI reads it exactly
 * that way.
 */
function recordingRail(rail: PayoutRail, corridor: Corridor, senderAddress: string): PayoutRail {
  // The orchestrator hands `submit` the very object `quote` returned, so the
  // order id can ride along without widening the PayoutRail interface.
  const orderIdOf = new WeakMap<object, string>();

  return {
    ...rail,

    async quote(req) {
      const q = await rail.quote(req);
      orderIdOf.set(q, req.orderId);
      return q;
    },

    async submit(q) {
      const submission = await rail.submit(q);
      // The broadcast already happened and cannot be undone. A failure to write
      // our own history row must therefore never propagate: it would abort
      // `release()` after the money left, leaving an order that looks unpaid
      // while CPN is paying it. Logged and swallowed, deliberately.
      try {
        await cpnStore().recordCpnPayment({
          paymentId: submission.paymentId,
          orderId: orderIdOf.get(q) ?? null,
          corridor: corridor.key,
          senderAddress,
          // The settlement wallet's key is held by this server (SELLER_PRIVATE_KEY),
          // unlike the browser cash-out where the seller signs. Say so honestly.
          signedBy: "server",
          sourceMinor: submission.requiredSourceMinor,
          sourceCurrency: q.sourceCurrency,
          destinationMinor: submission.destinationMinor,
          destinationCurrency: submission.destinationCurrency,
          destinationScale: submission.destinationScale,
          status: initialPaymentState(submission.status),
        });
      } catch (e) {
        // `error`, not `warn`: money moved and the history will not show it.
        // The first version of this swallowed a constraint violation at `warn`
        // and the row was simply absent, with nothing on screen to say why.
        console.error(`[cpn] payout ${submission.paymentId} broadcast but NOT recorded: ${String((e as Error).message)}`);
      }
      return submission;
    },

    // Only wired when the underlying rail polls at all. Same forward-only
    // reducer the webhook uses, so whichever arrives first wins and the other
    // is a no-op — a released payout advances to COMPLETED in the history
    // whether or not a webhook endpoint exists.
    ...(rail.status
      ? {
          async status(paymentId: string) {
            const observed = await rail.status!(paymentId);
            try {
              await persistStatus(paymentId, observed.status);
            } catch (e) {
              console.warn(`[cpn] status ${paymentId} not persisted: ${String((e as Error).message)}`);
            }
            return observed;
          },
        }
      : {}),
  };
}

/**
 * Move USDC out of the seller's wallet on Arc.
 *
 * Exists for the bank path's rebate. On the wallet path the surplus is EURC
 * sitting with the merchant, but a bank order runs no swap, so its surplus is
 * USDC sitting with the SELLER — a different token in a different wallet.
 * Sending the merchant's EURC there would move the wrong asset from the wrong
 * holder, and would succeed quietly enough to look correct.
 */
export async function sendSellerUsdc(to: string, amountMinor: bigint): Promise<{ txHash: string }> {
  const signer = getSellerSigner();
  const wallet = createWalletClient({ account: signer, chain: arcTestnet, transport: arcTransport() });
  const pub = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
  const hash = await wallet.writeContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amountMinor],
  });
  await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash };
}

/**
 * Who a bank-bound order must name as `receiver`.
 *
 * Not cosmetic: the off-ramp pulls from whoever holds the captured USDC, so if
 * the order paid a different address the payout would find nothing there.
 */
export function payoutSellerAddress(): string {
  return getSellerSigner().address;
}

/** Whether the demo can off-ramp at all — the CPN key is server-only and optional. */
export function payoutAvailable(): boolean {
  return Boolean(process.env.CIRCLE_CPN_KEY && process.env.SELLER_PRIVATE_KEY);
}

/** The raw intent the browser must sign, plus what Permit2 needs approved. */
export async function preparedIntent(paymentId: string): Promise<{
  messageToBeSigned: CpnTransaction["messageToBeSigned"];
  permitAmountMinor: string;
} | null> {
  const entry = await loadPrepared(paymentId);
  if (!entry) return null;
  const m = entry.transaction.messageToBeSigned;
  const permitted = (m.message as Record<string, any>)?.permitted?.amount;
  return { messageToBeSigned: m, permitAmountMinor: String(permitted ?? "0") };
}
