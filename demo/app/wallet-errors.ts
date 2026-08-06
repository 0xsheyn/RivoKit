/**
 * Reading what a wallet actually said.
 *
 * Its own module, free of App Kit, so both the lazily-loaded rails and the
 * always-loaded marketplace can use it without pulling ~370 kB into first paint.
 */

/**
 * Whether an EIP-1193 error carries `want` anywhere in its chain.
 *
 * The code is NOT reliably at `error.code`. Wallets and the layers around them
 * re-wrap: MetaMask surfaces `-32603` with the real code at
 * `data.originalError.code`, wagmi wraps provider errors under `cause`. Reading
 * only the top level makes a known condition look like an unknown fault.
 */
export function hasCode(e: unknown, want: number | string, depth = 0): boolean {
  if (e == null || typeof e !== "object" || depth > 4) return false;
  const o = e as Record<string, unknown>;
  if (o["code"] === want) return true;
  return ["data", "cause", "error", "originalError"].some((k) => hasCode(o[k], want, depth + 1));
}

/**
 * Whether a failed funding attempt may have left money in flight.
 *
 * This is the distinction that decides whether an order is still payable. A
 * CCTP burn that landed means the funds ARE moving and the order must stay in
 * `funding_pending` — retrying would burn a second time. Everything else (a
 * declined prompt, a dead RPC, a short balance, `BridgeFailedError`) moved
 * nothing, and leaving such an order stuck at "Processing payment…" strands it:
 * the pay control only renders while an order is payable.
 *
 * Default to TRUE for anything unrecognised. Being wrong in this direction
 * costs a stuck badge that the retry path below can clear; being wrong the
 * other way invites a double spend.
 */
export function fundsMayBeInFlight(e: unknown): boolean {
  // The SDK is explicit about both halves — see src/funding/bridge.ts.
  if (hasCode(e, "FUNDING_FAILED")) return false;      // burn never happened
  if (hasCode(e, "FUNDING_STUCK")) return true;        // burn landed, mint did not
  // Gateway spend reports its own resumability; a RESUMABLE spend has burned.
  if (hasCode(e, "RESUMABLE")) return true;
  if ((e as { recoverability?: string })?.recoverability === "RESUMABLE") return true;
  // Nothing was signed, so nothing can be in flight.
  if (hasCode(e, 4001)) return false;
  if (hasCode(e, "WALLET_CHAIN_REJECTED")) return false;
  // Our own pre-flight refusal: the plan was rejected before a single intent
  // was built, let alone signed.
  if (hasCode(e, "GATEWAY_BALANCE_SHORT")) return false;
  if (isPreflightKitError(e)) return false;
  return true;
}

/**
 * A KitError raised while VALIDATING a transfer, before anything is signed.
 *
 * App Kit classifies its errors by `type`, and two of those classes are decided
 * entirely from inputs and balances: `INPUT` (bad amount, unsupported route,
 * unknown chain) and `BALANCE` (not enough token, not enough gas). Both are
 * refusals to start. Reading them as "money might be moving" is what turned a
 * Gateway spend that never left the browser — "Insufficient USDC balance on
 * Ethereum Sepolia. Available: 0 USDC" — into an order frozen at
 * `funding_pending` under a "Funding never completed" warning, with its pay
 * control gone and nothing to retry with.
 *
 * Matched on `type` rather than on the numeric code so a new BALANCE/INPUT
 * member of the taxonomy is covered the day it ships. Everything else still
 * defaults to TRUE upstream: `EXECUTION`, `ONCHAIN` and `NETWORK` can all fail
 * after a burn has landed.
 */
function isPreflightKitError(e: unknown, depth = 0): boolean {
  if (e == null || typeof e !== "object" || depth > 4) return false;
  const o = e as Record<string, unknown>;
  if (o["type"] === "INPUT" || o["type"] === "BALANCE") return true;
  return ["data", "cause", "error", "originalError"].some((k) => isPreflightKitError(o[k], depth + 1));
}

/**
 * Last-resort detection of "this wallet does not know that chain".
 *
 * Some wallets describe it without ever setting 4902. Acting on the text is
 * safe where the only consequence is ATTEMPTING to add the chain — the user
 * still approves it, and a wrong guess fails loudly instead of silently.
 */
export const looksUnrecognizedChain = (e: unknown) =>
  /unrecognized chain|chain (?:id )?not (?:added|found|recognized)|try adding the chain|add.*network.*first/i
    .test(String((e as Error)?.message ?? ""));

/**
 * What to show the user for a failed wallet interaction.
 *
 * Only 4001 is a decision; everything else is a fault and must say what it
 * actually was. Reporting every failure as "rejected in wallet" is worse than
 * useless — it sends the user looking for a prompt they never declined, and
 * hides the real cause (a chain mismatch, a malformed payload, a dead RPC).
 */
export function walletErrorMessage(e: unknown, declined: string): string {
  if (hasCode(e, 4001)) return declined;
  const raw = String((e as Error)?.message ?? e ?? "").trim();
  return raw ? raw.slice(0, 240) : declined;
}
