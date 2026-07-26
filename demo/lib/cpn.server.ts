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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installCircleDnsPinning } from "../../src/lib/circle-dns.ts";
import { sleep } from "../../src/lib/rpc.ts";
import { ARC_TESTNET_RPC_FALLBACKS, PERMIT2_ADDRESS, USDC_ADDRESS, arcTestnet } from "../../src/constants/arc.ts";
import { createCpnRamp, type CpnRamp } from "../../src/ramp/cpn-ramp.ts";
import type { CpnPayment, CpnQuote, CpnTransaction } from "../../src/ramp/cpn-client.ts";
import type { CpnFieldValue } from "../../src/ramp/cpn-encrypt.ts";

// Next loads .env from demo/, but credentials live in the repo-root .env.local.
function loadRootEnv() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    const key = m?.[1];
    const val = m?.[2];
    if (key && val && process.env[key] == null) process.env[key] = val;
  }
}
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
  "EUR-SEPA": {
    key: "EUR-SEPA", label: "🇪🇺 EUR · SEPA", currency: "EUR", method: "SEPA", minUsdc: 11, country: "FR",
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

/** Quote + create payment + create transaction for a corridor. No broadcast. */
export async function preparePayment(sourceAmountUsdc: string, corridorKey: string): Promise<{
  quote: CpnQuote;
  fees: { total: { amount: string; currency: string }; byType: Record<string, string> };
  spreadBps: number;
  payment: CpnPayment;
  transaction: CpnTransaction;
}> {
  const corridor = corridorFor(corridorKey);
  const ramp = getRampFor(corridor);
  const signer = getSellerSigner();
  const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: sourceAmountUsdc });
  const { payment, transaction } = await ramp.prepare({
    quote,
    travelRule: [...buildTravelRule(corridor.address), ...(corridor.extraTravelRule ?? [])],
    beneficiaryAccount: corridor.beneficiary,
    senderAddress: signer.address,
    refundAddress: signer.address,
    useCase: "B2B",
    reasonForPayment: "PMT001",
    customerRefId: `demo-${quote.id.slice(0, 8)}`,
  });
  preparedTx.set(payment.id, { transaction, corridorKey: corridor.key });
  return { quote, fees, spreadBps, payment, transaction };
}

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
    }
    if (last === "COMPLETED" || last === "FAILED") break;
  }
  return { transactionId: submitted.id, submittedStatus: submitted.status, lifecycle, finalStatus: last };
}
