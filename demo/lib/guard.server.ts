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
 *   the CAP   — a ceiling on any single amount, applied whether or not the
 *               caller is unlocked. Answers "how much?" It is what stops an
 *               unlocked session, a typo, or a compromised cookie from emptying
 *               a wallet in one call.
 *
 * FAIL CLOSED IN PRODUCTION. With no `DEMO_WRITE_KEY` set, a production build
 * refuses every gated action outright rather than running open — an unset
 * variable is exactly how this hole would come back. Local development with no
 * key set stays open, so `npm run dev` needs no ceremony.
 *
 * This is NOT authentication for a real product. It is one shared secret for one
 * operator's testnet demo. It is enough to stop the endpoint being an open
 * faucet, and it is not enough to be called an access-control system.
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
  /** No key, not production: open, for local development only. */
  | "open-dev"
  /** No key, production: gated actions are refused outright. */
  | "locked";

export function guardMode(): GuardMode {
  if (KEY) return "enforced";
  return process.env.NODE_ENV === "production" ? "locked" : "open-dev";
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
  const mode = guardMode();
  if (mode === "open-dev") return true;
  if (mode === "locked") return false;
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
  if (guardMode() === "locked") {
    throw new DemoLockedError(
      `${what} is disabled: this deployment has no DEMO_WRITE_KEY set. ` +
        "Set it in the environment and reload — actions that move money stay refused until it is there.",
    );
  }
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

/** USDC/EURC, 6 dp. 25 USDC clears the EUR/SEPA minimum with room and caps the bleed. */
export const CAP_TOKEN_MINOR = capFromEnv("DEMO_CAP_TOKEN_MINOR", 25_000_000n);
/** Fiat at 2 dp — Circle Mint redeems and any destination amount. */
export const CAP_FIAT_MINOR = capFromEnv("DEMO_CAP_FIAT_MINOR", 2_500n);

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
