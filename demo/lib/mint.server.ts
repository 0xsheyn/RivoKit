/**
 * Server-only Circle Mint wiring — the euro-native fiat leg (redeem → bank).
 *
 * Circle Mint is a SEPARATE product from CPN: base `api-sandbox.circle.com`,
 * authenticated by CIRCLE_RAMP_KEY (the "On/off ramp (Mint)" capability). It
 * redeems the Mint account's balance to a linked bank — the final step of the
 * StableFX path (USDC→EURC→Circle Mint→EUR bank). This demo's sandbox account
 * holds USD and uses a wire bank; in production the same calls redeem EURC→EUR
 * to a SEPA bank.
 *
 * Never import from a client component — it reads CIRCLE_RAMP_KEY.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { installCircleDnsPinning } from "../../src/lib/circle-dns.ts";

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

const BASE = "https://api-sandbox.circle.com";

function mintKey(): string {
  const k = process.env.CIRCLE_RAMP_KEY;
  if (!k) throw new Error("CIRCLE_RAMP_KEY kosong — key Circle Mint (kapabilitas On/off ramp).");
  return k;
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${mintKey()}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const msg = parsed?.message ?? (typeof parsed === "string" ? parsed : JSON.stringify(parsed));
    throw new Error(`Circle Mint ${res.status}: ${msg}`);
  }
  return (parsed?.data ?? parsed) as T;
}

export type MintBalance = { amount: string; currency: string };

/** The Mint account's available balance — what can be redeemed to a bank. */
export async function mintBalance(): Promise<MintBalance[]> {
  const data = await call<{ available: MintBalance[] }>("GET", "/v1/businessAccount/balances");
  return data.available ?? [];
}

export type MintDepositInfo = { address: string; chains: string[] };

/**
 * Where the seller sends USDC to top up the Mint balance — one address, many
 * EVM chains. Arc is NOT among them, so the seller's Arc proceeds need a CCTP
 * bridge to one of these chains first. Crediting is async (verified live).
 */
export async function mintDepositInfo(): Promise<MintDepositInfo> {
  const addrs = await call<Array<{ address: string; chain: string; currency: string }>>(
    "GET", "/v1/businessAccount/wallets/addresses/deposit",
  );
  const usd = addrs.filter((a) => a.currency === "USD");
  return { address: usd[0]?.address ?? "", chains: usd.map((a) => a.chain) };
}

let cachedBankId: string | null = null;

/** Reuse a linked wire bank, or register a mock one (sandbox). */
async function ensureBank(): Promise<string> {
  if (cachedBankId) return cachedBankId;
  const banks = await call<Array<{ id: string }>>("GET", "/v1/businessAccount/banks/wires");
  if (banks[0]?.id) {
    cachedBankId = banks[0].id;
    return cachedBankId;
  }
  const bank = await call<{ id: string }>("POST", "/v1/businessAccount/banks/wires", {
    idempotencyKey: randomUUID(),
    accountNumber: "12340010",
    routingNumber: "121000248",
    billingDetails: { name: "Rivo Seller", city: "Boston", country: "US", line1: "100 Money Street", district: "MA", postalCode: "01234" },
    bankAddress: { bankName: "WELLS FARGO BANK, NA", city: "San Francisco", country: "US", line1: "1 Bank St", district: "CA" },
  });
  cachedBankId = bank.id;
  return cachedBankId;
}

export type MintPayout = {
  id: string;
  status: string;
  amount: string;
  currency: string;
  bankName: string;
};

/** Redeem `amount` of the balance to the linked bank (a Circle Mint payout). */
export async function mintRedeem(amount: string, currency = "USD"): Promise<MintPayout> {
  const bankId = await ensureBank();
  const p = await call<any>("POST", "/v1/businessAccount/payouts", {
    idempotencyKey: randomUUID(),
    destination: { type: "wire", id: bankId },
    amount: { currency, amount },
  });
  return {
    id: p.id,
    status: p.status,
    amount: p.amount?.amount ?? amount,
    currency: p.amount?.currency ?? currency,
    bankName: p.destination?.name ?? "bank",
  };
}
