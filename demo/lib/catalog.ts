/**
 * Demo storefront catalog. Pure data — safe to import from client and server.
 *
 * Prices are micro-EURC (6 decimals): what the seller is GUARANTEED to receive.
 * Every listing settles to the single demo merchant wallet — the seller names
 * are cosmetic (one testnet wallet plays every shop).
 */
export type Product = {
  id: string;
  name: string;
  blurb: string;
  seller: string;
  emoji: string;
  /** micro-EURC, the guaranteed price €P. */
  priceEURMinor: string;
};

/**
 * Six listings, split evenly either side of the bank threshold, because the
 * price is what chooses the settlement destination — see `canPayoutToBank`.
 * The three cheap ones can only end as EURC in a wallet; the three above it go
 * all the way to a bank account over CPN.
 *
 * The dear half is capped at €15: the buyer pays in USDC plus a 400 bps buffer,
 * and the demo buyer's Arc balance has to cover every one of them.
 */
export const CATALOG: Product[] = [
  // Under the threshold — wallet settlement (floored EURC on Arc).
  { id: "tee", name: "Cotton Shirt", blurb: "Plain weave, regular fit", seller: "Baumwoll Berlin", emoji: "👕", priceEURMinor: "6500000" },
  { id: "sck", name: "Wool Socks", blurb: "Merino blend, ribbed cuff", seller: "Nordic Home Oslo", emoji: "🧦", priceEURMinor: "8000000" },
  { id: "cap", name: "Canvas Cap", blurb: "Six panel, adjustable strap", seller: "Atelier Lyon", emoji: "🧢", priceEURMinor: "9000000" },
  // Above the threshold — bank settlement over CPN's EUR/SEPA corridor.
  { id: "snk", name: "Canvas Sneakers", blurb: "Rubber sole, cotton laces", seller: "Calzature Milano", emoji: "👟", priceEURMinor: "11500000" },
  { id: "bag", name: "Leather Tote", blurb: "Full grain, cotton lining", seller: "Cuir Bruxelles", emoji: "👜", priceEURMinor: "13000000" },
  { id: "jkt", name: "Denim Jacket", blurb: "Rigid denim, button front", seller: "Werkraum Zürich", emoji: "🧥", priceEURMinor: "14500000" },
];

/**
 * Whether this listing settles to a bank rather than to a wallet.
 *
 * The buyer is not asked: CPN's EUR/SEPA corridor takes a minimum of ~11 USDC
 * (≈ €9.4), enforced against the DESTINATION side, so a cheap order simply
 * cannot reach a bank — `createOrder` refuses it rather than stalling after
 * capture. Offering the choice would mean offering a checkout that fails, so
 * the price decides instead.
 *
 * Still only a hint — the authority is `PayoutRail.limits()`, read live at
 * `createOrder`, because that USDC minimum drifts with FX. The threshold sits
 * deliberately above the observed €9.4 so nothing lands in the gap.
 */
export function canPayoutToBank(p: Product): boolean {
  return BigInt(p.priceEURMinor) >= 10_000_000n;
}

export function productById(id: string): Product | undefined {
  return CATALOG.find((p) => p.id === id);
}

/** €12.34 from "12340000". */
export function fmtEUR(minor: string | null | undefined): string {
  if (minor == null) return "—";
  return `€${(Number(minor) / 1e6).toFixed(2)}`;
}
