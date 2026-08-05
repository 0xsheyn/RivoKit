/**
 * The server-side gate for actions that move money.
 *
 * WHY THIS EXISTS. `cpnBroadcastAction` used to carry the comment "the panel
 * gates this behind an explicit confirmation" — and it did, in the panel. But a
 * Server Action is a POST endpoint whose id ships inside the JS bundle handed to
 * every visitor, so the confirmation dialog is decoration to anyone calling the
 * endpoint directly. On a public URL that meant a stranger could broadcast an
 * irreversible CPN payment signed with the seller's server-held key, redeem from
 * the Circle Mint balance, or capture and refund escrow — none of it authorised,
 * all of it spending the funds the whole demo runs on.
 *
 * Two independent controls, because they fail in different directions:
 *
 *   the LOCK  — proves the caller is the operator. Answers "may you?"
 *               OPT-IN: set `DEMO_WRITE_KEY` and every gated action needs the
 *               unlock cookie. Leave it unset and the demo runs open, which is
 *               how it ran throughout the build phase.
 *   the CAP   — a ceiling on any single amount, applied ALWAYS: unlocked,
 *               locked, or with no key at all. Answers "how much?"
 *
 * OPEN BY DEFAULT, AND THAT IS A CHOICE. An earlier version failed closed in
 * production — no key meant every gated action was refused. That is the right
 * default for a deployment holding value; it is the wrong default here, where
 * the point is that anyone can walk up to a public URL and watch the whole
 * settlement run end to end. The wallets behind it are disposable testnet keys
 * holding testnet USDC.
 *
 * So the honest description of what protects this deployment is: the CAP, and
 * nothing else. A stranger can trigger any gated action, including an
 * irreversible CPN broadcast signed with the seller's server-held key. What they
 * cannot do is move more than the cap in one call — which bounds the damage to
 * "the demo wallets run dry and someone has to refill them", not to anything
 * that matters off testnet.
 *
 * This was never authentication for a real product, and now it is not even a
 * gate. Anything holding real value needs a different mechanism entirely.
 */
import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fromDecimalStringScaled } from "../../src/settlement-fx/units.ts";

const KEY = process.env.DEMO_WRITE_KEY;
const COOKIE = "rivo_demo_unlock";
/** Long enough for a demo session, short enough that a shared laptop forgets. */
const MAX_AGE_S = 8 * 60 * 60;

export type GuardMode =
  /** A key is set: gated actions require the unlock cookie. */
  | "enforced"
  /** No key: gated actions run for anyone. Caps still apply. */
  | "open";

/**
 * No environment check here on purpose. A rule that behaves one way locally and
 * another way in production means the thing you tested is not the thing you
 * shipped — and it was that asymmetry, not the openness, that made the old
 * `locked` mode surprising.
 */
export function guardMode(): GuardMode {
  return KEY ? "enforced" : "open";
}

/**
 * The cookie value is derived from the key, never the key itself: a cookie that
 * carried the secret would hand it back to anyone who read the jar, and the
 * whole point is that the secret stays on the server.
 */
function derive(key: string): string {
  return createHmac("sha256", key).update("rivokit-demo-unlock-v1").digest("hex");
}

/** Constant-time, and length-safe — `timingSafeEqual` throws on a length mismatch. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function unlock(secret: string): Promise<boolean> {
  if (!KEY || !sameSecret(secret, KEY)) return false;
  const jar = await cookies();
  jar.set(COOKIE, derive(KEY), {
    httpOnly: true,
    sameSite: "lax",
    // Vercel serves HTTPS; a `secure` cookie on a plain-http localhost would
    // never be stored, which is why this follows the environment.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
  return true;
}

export async function lock(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function isUnlocked(): Promise<boolean> {
  if (guardMode() === "open") return true;
  const got = (await cookies()).get(COOKIE)?.value;
  return got != null && sameSecret(got, derive(KEY!));
}

/** Thrown rather than returned: a gated action must not continue by accident. */
export class DemoLockedError extends Error {
  readonly code = "DEMO_LOCKED";
  constructor(message: string) {
    super(message);
    this.name = "DemoLockedError";
  }
}

/**
 * Refuse unless the caller has unlocked. `what` names the action in the error,
 * because "forbidden" tells an operator nothing about which control tripped.
 */
export async function assertUnlocked(what: string): Promise<void> {
  if (!(await isUnlocked())) {
    throw new DemoLockedError(`${what} requires the demo to be unlocked. Enter the demo key first.`);
  }
}

/* ── Caps ──────────────────────────────────────────────────────────────── */

function capFromEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * USDC/EURC, 6 dp — sized to the storefront's most expensive listing and no
 * higher, because with the demo running open this is the only thing bounding a
 * single call.
 *
 * The arithmetic, from a live EUR/SEPA quote on 2026-08-05: the top listing is
 * €14.50 (`demo/lib/catalog.ts`), which CPN prices at 16.998225 USDC. A
 * bank-bound order authorizes that PLUS a 400 bps buffer for CPN's spread and
 * its four fees, so the amount that actually moves is 17.678154 USDC. 18 is that
 * rounded up, which leaves ~1.8% of headroom for FX drift.
 *
 * Raise it if EUR strengthens enough that the top listing stops fitting — the
 * symptom is a cash-out refusing at the ceiling with proceeds that came from a
 * single legitimate sale. Do not raise it "to be safe": the ceiling is the whole
 * defence, and every unused USDC of it is bleed a stranger can cause per call.
 */
export const CAP_TOKEN_MINOR = capFromEnv("DEMO_CAP_TOKEN_MINOR", 18_000_000n);
/**
 * Fiat at 2 dp — Circle Mint redeems and any destination amount.
 *
 * Brought down alongside the token cap and for the same reason. €15.00 is the
 * top listing rounded up on the fiat side; it clears Mint's redeem minimum with
 * room, and nothing in this demo legitimately redeems more in one call.
 */
export const CAP_FIAT_MINOR = capFromEnv("DEMO_CAP_FIAT_MINOR", 1_500n);

/**
 * The ceiling, applied to every gated amount whether or not the caller is
 * unlocked.
 *
 * Deliberately independent of the lock. The lock can be defeated by a leaked
 * key or a borrowed browser; the cap cannot be defeated at all from outside the
 * server, so it is what actually bounds the worst case.
 */
export function assertWithinCap(amountMinor: bigint, capMinor: bigint, what: string, scale = 6): void {
  if (amountMinor <= 0n) {
    throw new DemoLockedError(`${what}: amount must be positive.`);
  }
  if (amountMinor > capMinor) {
    const fmt = (v: bigint) => (Number(v) / 10 ** scale).toFixed(scale === 6 ? 2 : scale);
    throw new DemoLockedError(
      `${what}: ${fmt(amountMinor)} is above this demo's per-action ceiling of ${fmt(capMinor)}. ` +
        "Raise DEMO_CAP_TOKEN_MINOR / DEMO_CAP_FIAT_MINOR if that is genuinely intended.",
    );
  }
}

/** Parse a user-supplied decimal and cap it in one step. Throws on malformed input. */
export function assertDecimalWithinCap(value: string, capMinor: bigint, what: string, scale = 6): bigint {
  let minor: bigint;
  try {
    minor = fromDecimalStringScaled(value.trim(), scale);
  } catch {
    throw new DemoLockedError(`${what}: "${value}" is not a valid amount.`);
  }
  assertWithinCap(minor, capMinor, what, scale);
  return minor;
}
