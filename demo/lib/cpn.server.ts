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
import { applyPaymentEvent, type CpnPaymentState } from "../../src/ramp/cpn-state.ts";
import { fromDecimalStringScaled } from "../../src/settlement-fx/units.ts";
import { createOrderStore, type OrderStore } from "../../src/orchestrator/order-store.ts";
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
export type CorridorInfo = { key: string; label: string; currency: string; method: string; minUsdc: number };

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
  "EUR-SEPA": {
    key: "EUR-SEPA", label: "🇪🇺 EUR · SEPA", currency: "EUR", method: "SEPA", minUsdc: 12, country: "FR",
    address: { street: "1 Rue de Rivoli", city: "Paris", stateProvince: "IDF", country: "FR", postalCode: "75001" },
    beneficiary: [
      { name: "IBAN", value: "FR7630006000011234567890189" },
      { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" },
    ],
  },
  "BRL-PIX": {
    key: "BRL-PIX", label: "🇧🇷 BRL · PIX", currency: "BRL", method: "PIX", minUsdc: 10, country: "BR",
    address: { street: "Av. Paulista 1000", city: "Sao Paulo", stateProvince: "SP", country: "BR", postalCode: "01310-100" },
    beneficiary: [
      { name: "RECIPIENT_ID_NUMBER", value: "11222333000181" },
      { name: "RECIPIENT_EVP", value: "123e4567-e89b-12d3-a456-426614174000" },
    ],
  },
  "MXN-SPEI": {
    key: "MXN-SPEI", label: "🇲🇽 MXN · SPEI", currency: "MXN", method: "SPEI", minUsdc: 11, country: "MX",
    address: { street: "Av. Reforma 100", city: "Mexico City", stateProvince: "CDMX", country: "MX", postalCode: "06600" },
    beneficiary: [{ name: "CLABE", value: "032180000118359719" }],
    extraTravelRule: [{ name: "BENEFICIARY_NATIONAL_IDENTIFICATION_NUMBER", value: "AAA010101AAA" }],
  },
  "USD-WIRE": {
    key: "USD-WIRE", label: "🌍 USD · WIRE", currency: "USD", method: "WIRE", minUsdc: 61, country: "US",
    address: { street: "5th Avenue 1", city: "New York", stateProvince: "NY", country: "US", postalCode: "10001" },
    beneficiary: [
      { name: "BANK_NAME", value: "First National Bank" },
      { name: "SWIFT_CODE", value: "FNBKUS33" },
      { name: "BANK_COUNTRY", value: "US" },
      { name: "ACCOUNT_NUMBER", value: "1234567890" },
      { name: "RECIPIENT_LEGAL_NAME", value: "Acme LLC" },
    ],
  },
};
const DEFAULT_CORRIDOR = "EUR-SEPA";

/** The corridors the seller can cash out to. */
export function corridorList(): CorridorInfo[] {
  return Object.values(CORRIDORS).map(({ key, label, currency, method, minUsdc }) => ({
    key, label, currency, method, minUsdc,
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

/** Prepared transactions held between prepare and broadcast, keyed by paymentId. */
const preparedTx = new Map<string, { transaction: CpnTransaction; corridorKey: string }>();

// The public Arc RPC rate-limits hard; rotate across all endpoints so a single
// slow host can't stall an approve or a receipt wait (a hung broadcast).
const arcTransport = () => fallback(ARC_TESTNET_RPC_FALLBACKS.map((u) => http(u)));

/**
 * The SELLER's wallet — the funds owner who off-ramps. In the demo a dedicated
 * testnet EOA (relayer key) stands in for the seller; in production the seller
 * signs in their own wallet and `ramp.submit` takes any Account.
 */
function getSellerSigner() {
  const pk = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY (the demo seller wallet) is empty — check .env.local");
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
  });
  preparedTx.set(payment.id, { transaction, corridorKey: corridor.key });

  // Persist the cash-out now, not after broadcasting. CPN can report on it
  // (RFI, delay, failure) from the moment the payment exists, and a webhook
  // about a payment we never stored is dropped as unknown.
  await cpnStore().recordCpnPayment({
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
 * Uses the same reducer the webhook path uses, so polling can never push the
 * record somewhere a webhook would have refused — and a status we already hold
 * is a silent no-op rather than a redundant write.
 */
async function persistStatus(paymentId: string, status: string): Promise<void> {
  const store = cpnStore();
  const current = await store.getCpnPayment(paymentId);
  if (!current) return;
  const outcome = applyPaymentEvent(current.status, {
    component: "payment",
    notificationType: POLL_EVENT[status] ?? "",
    paymentId,
    raw: { polled: status },
  });
  if (outcome.changed) await store.advanceCpnPayment(paymentId, outcome.state);
}

/** Poll status → the webhook notificationType that means the same thing. */
const POLL_EVENT: Record<string, string> = {
  CRYPTO_FUNDS_PENDING: "cpn.payment.cryptoFundsPending",
  FIAT_PAYMENT_INITIATED: "cpn.payment.fiatPaymentInitiated",
  COMPLETED: "cpn.payment.completed",
  FAILED: "cpn.payment.failed",
};

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
  const entry = preparedTx.get(paymentId);
  if (!entry) throw new Error("Payment was never prepared (or the server restarted) — prepare it again.");
  const ramp = getRampFor(corridorFor(entry.corridorKey));
  const signer = getSellerSigner();

  const permitAmount = BigInt((entry.transaction.messageToBeSigned.message as any)?.permitted?.amount ?? 0);
  await ensureAllowance(permitAmount > 0n ? permitAmount : 20_000_000n);

  const submitted = await ramp.submit({ paymentId, transaction: entry.transaction }, signer);
  preparedTx.delete(paymentId);

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
  const entry = preparedTx.get(paymentId);
  if (!entry) throw new Error("Payment was never prepared (or the server restarted) — prepare it again.");
  const ramp = getRampFor(corridorFor(entry.corridorKey));

  const submitted = await ramp.submitSigned({ paymentId, transaction: entry.transaction }, signature);
  preparedTx.delete(paymentId);

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

/** The raw intent the browser must sign, plus what Permit2 needs approved. */
export function preparedIntent(paymentId: string): {
  messageToBeSigned: CpnTransaction["messageToBeSigned"];
  permitAmountMinor: string;
} | null {
  const entry = preparedTx.get(paymentId);
  if (!entry) return null;
  const m = entry.transaction.messageToBeSigned;
  const permitted = (m.message as Record<string, any>)?.permitted?.amount;
  return { messageToBeSigned: m, permitAmountMinor: String(permitted ?? "0") };
}
