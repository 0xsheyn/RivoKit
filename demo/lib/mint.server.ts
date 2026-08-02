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
import { randomUUID } from "node:crypto";
import { installCircleDnsPinning } from "../../src/lib/circle-dns.ts";
import { loadRootEnv } from "../../scripts/lib/env.mjs";

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

export type MintDepositRoute = { currency: string; chain: string; address: string };
export type MintDepositInfo = {
  address: string;
  chains: string[];
  routes: MintDepositRoute[];
  /** The EUR route on Arc, when Circle offers one — the seller's direct exit. */
  eurOnArc: MintDepositRoute | null;
};

/**
 * Where the seller tops up the Mint balance — one address, many chains.
 *
 * This used to filter to `currency === "USD"`, which silently discarded the row
 * that matters most: Circle exposes an **EUR deposit address on ARC**. The
 * seller's floored EURC can therefore go straight from Arc into the Mint EUR
 * balance and out to a SEPA bank, with no CCTP bridge and no detour through
 * USD. Keep every route and let the caller choose. Crediting is async.
 */
let depositCache: { at: number; info: MintDepositInfo } | null = null;
const DEPOSIT_TTL_MS = 5 * 60_000;

export async function mintDepositInfo(): Promise<MintDepositInfo> {
  // Deposit addresses do not change, and the withdraw page asks for them from
  // two panels at once — each round trip pays for a DNS-over-HTTPS lookup
  // because every *.circle.com name is hijacked on this network.
  if (depositCache && Date.now() - depositCache.at < DEPOSIT_TTL_MS) return depositCache.info;

  const addrs = await call<Array<{ address: string; chain: string; currency: string }>>(
    "GET", "/v1/businessAccount/wallets/addresses/deposit",
  );
  const routes: MintDepositRoute[] = addrs.map((a) => ({
    currency: a.currency,
    chain: a.chain,
    address: a.address,
  }));
  const usd = routes.filter((r) => r.currency === "USD");
  const info: MintDepositInfo = {
    address: usd[0]?.address ?? routes[0]?.address ?? "",
    chains: usd.map((r) => r.chain),
    routes,
    eurOnArc: routes.find((r) => r.currency === "EUR" && r.chain === "ARC") ?? null,
  };
  depositCache = { at: Date.now(), info };
  return info;
}

/** A linked bank and the rails it actually accepts, per currency. */
export type MintBank = {
  id: string;
  name: string;
  /** Currencies this account can receive over SEPA. */
  sepa: string[];
  /** Currencies it can receive over wire. */
  wire: string[];
  /** Billing country of the account — the wire tiebreak. */
  country: string;
};

let bankCache: MintBank[] | null = null;

/** Where a currency's wire account is expected to sit, when several qualify. */
const HOME_COUNTRY: Record<string, string> = { USD: "US", EUR: "DE" };

/**
 * The linked banks, with their rails.
 *
 * `transferTypesInfo` is null in the LIST response and only populated on the
 * per-bank GET, so each one is fetched individually — picking a bank from the
 * list alone cannot tell EUR/SEPA apart from a euro-capable wire account.
 */
async function linkedBanks(): Promise<MintBank[]> {
  if (bankCache) return bankCache;
  const list = await call<Array<{ id: string; description: string }>>("GET", "/v1/businessAccount/banks/wires");
  bankCache = await Promise.all(
    list.map(async (b) => {
      const d = await call<any>("GET", `/v1/businessAccount/banks/wires/${b.id}`);
      const t = d?.transferTypesInfo ?? {};
      return {
        id: b.id,
        name: b.description,
        sepa: (t.sepa?.currencies ?? []) as string[],
        wire: (t.wire?.currencies ?? []) as string[],
        country: (d?.billingDetails?.country ?? "") as string,
      };
    }),
  );
  return bankCache;
}

/**
 * The bank to redeem `currency` into, preferring a SEPA-capable account.
 *
 * The rail is a property of the ACCOUNT, not of the payout call: every proven
 * redemption used `destination.type: "wire"`, and it was the euro-capable
 * Commerzbank account plus `amount.currency: EUR` that made it settle over
 * SEPA. So this picks the account and leaves the call shape alone.
 */
async function ensureBank(currency: string): Promise<{ id: string; rail: "sepa" | "wire" }> {
  const banks = await linkedBanks();
  const bySepa = banks.find((b) => b.sepa.includes(currency));
  if (bySepa) return { id: bySepa.id, rail: "sepa" };

  // Several accounts may accept the same currency over wire (the euro account
  // here also lists USD), so prefer the one domiciled where that currency is —
  // otherwise the choice silently depends on list order.
  const wire = banks.filter((b) => b.wire.includes(currency));
  const home = HOME_COUNTRY[currency];
  const byWire = wire.find((b) => b.country === home) ?? wire[0];
  if (byWire) return { id: byWire.id, rail: "wire" };

  // Nothing linked for this currency — register the sandbox's mock US wire
  // account. Only ever reachable for USD; a EUR redemption with no euro account
  // should fail loudly rather than quietly land somewhere else.
  if (currency !== "USD") {
    throw new Error(`No linked bank accepts ${currency}. Link one in the Circle console first.`);
  }
  const bank = await call<{ id: string }>("POST", "/v1/businessAccount/banks/wires", {
    idempotencyKey: randomUUID(),
    accountNumber: "12340010",
    routingNumber: "121000248",
    billingDetails: { name: "Rivo Seller", city: "Boston", country: "US", line1: "100 Money Street", district: "MA", postalCode: "01234" },
    bankAddress: { bankName: "WELLS FARGO BANK, NA", city: "San Francisco", country: "US", line1: "1 Bank St", district: "CA" },
  });
  bankCache = null;
  return { id: bank.id, rail: "wire" };
}

export type MintPayout = {
  id: string;
  status: string;
  amount: string;
  currency: string;
  bankName: string;
  /** Which rail the destination account settles the redemption over. */
  rail?: "sepa" | "wire";
  /** Circle's `createDate`; absent on the payout just created. */
  createdAt?: string;
};

/**
 * Past redemptions, newest first — read back from Circle rather than kept
 * locally, so a payout that moved on after the tab was closed still shows its
 * real status.
 */
export async function mintPayouts(limit = 10): Promise<MintPayout[]> {
  const rows = await call<any[]>("GET", `/v1/businessAccount/payouts?pageSize=${limit}`);
  return (rows ?? []).map((p) => ({
    id: p.id,
    status: p.status,
    amount: p.amount?.amount ?? "0",
    currency: p.amount?.currency ?? "USD",
    bankName: p.destination?.name ?? "bank",
    createdAt: p.createDate ?? "",
  }));
}

/**
 * Redeem `amount` of the balance to a linked bank (a Circle Mint payout).
 *
 * Defaults to EUR: that is the balance RivoKit's settlement can actually reach,
 * because Circle exposes a EUR deposit address on ARC and the floored EURC goes
 * into it with no bridge. The USD balance has no Arc deposit route at all.
 */
export async function mintRedeem(amount: string, currency = "EUR"): Promise<MintPayout> {
  const bank = await ensureBank(currency);
  const p = await call<any>("POST", "/v1/businessAccount/payouts", {
    idempotencyKey: randomUUID(),
    destination: { type: "wire", id: bank.id },
    amount: { currency, amount },
  });
  return {
    id: p.id,
    status: p.status,
    amount: p.amount?.amount ?? amount,
    currency: p.amount?.currency ?? currency,
    bankName: p.destination?.name ?? "bank",
    rail: bank.rail,
  };
}
