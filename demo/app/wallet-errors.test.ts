/**
 * Reading a wallet error correctly, because getting it wrong is what a user sees.
 *
 * Two live symptoms drove these: an add-chain recovery that never ran because
 * 4902 was nested, and "Signature rejected in wallet" shown for a failure the
 * user never declined — which sent them looking for a prompt that never existed.
 */
import { describe, expect, it } from "vitest";
import { fundsMayBeInFlight, hasCode, looksUnrecognizedChain, walletErrorMessage } from "./wallet-errors.ts";

const withCode = (code: number | string, message = "boom") =>
  Object.assign(new Error(message), { code });

describe("hasCode", () => {
  it("finds a top-level code", () => {
    expect(hasCode(withCode(4001), 4001)).toBe(true);
  });

  it("finds the code MetaMask buries under data.originalError", () => {
    const e = Object.assign(new Error("Internal JSON-RPC error."), {
      code: -32603,
      data: { originalError: { code: 4902 } },
    });
    expect(hasCode(e, 4902)).toBe(true);
    expect(hasCode(e, -32603)).toBe(true);
  });

  it("finds the code wagmi puts under cause", () => {
    const e = Object.assign(new Error("User rejected the request."), { cause: withCode(4001) });
    expect(hasCode(e, 4001)).toBe(true);
  });

  it("does not invent a code that is not there", () => {
    expect(hasCode(withCode(-32603), 4001)).toBe(false);
    expect(hasCode(new Error("plain"), 4001)).toBe(false);
    expect(hasCode(null, 4001)).toBe(false);
    expect(hasCode("string", 4001)).toBe(false);
  });

  it("stops rather than recursing forever on a self-referencing error", () => {
    const e: Record<string, unknown> = { code: -1 };
    e.cause = e;
    expect(hasCode(e, 4001)).toBe(false);
  });
});

describe("looksUnrecognizedChain", () => {
  it("recognises the wording wallets use when a chain is unknown", () => {
    expect(looksUnrecognizedChain(new Error("Unrecognized chain ID. Try adding the chain first."))).toBe(true);
  });

  it("stays quiet for an ordinary failure", () => {
    expect(looksUnrecognizedChain(new Error("insufficient funds for gas"))).toBe(false);
  });
});

describe("walletErrorMessage", () => {
  it("uses the declined text ONLY for 4001", () => {
    expect(walletErrorMessage(withCode(4001), "declined")).toBe("declined");
    expect(walletErrorMessage(Object.assign(new Error("x"), { cause: withCode(4001) }), "declined")).toBe("declined");
  });

  it("reports what actually went wrong for anything else", () => {
    // The exact regression: a chain mismatch is not a rejection, and saying so
    // sends the user looking for a prompt they never saw.
    const e = new Error('Chain "Arc Testnet" does not match the connected chain.');
    expect(walletErrorMessage(e, "Signature rejected in wallet")).toContain("does not match");
  });

  it("falls back to the declined text when there is nothing to report", () => {
    expect(walletErrorMessage(new Error("   "), "declined")).toBe("declined");
    expect(walletErrorMessage(undefined, "declined")).toBe("declined");
  });
});

describe("fundsMayBeInFlight", () => {
  it("says NO only where nothing can have been signed", () => {
    // BridgeFailedError: the bridge came back with the funds still on the
    // source chain. This is the case that must stay payable.
    expect(fundsMayBeInFlight(withCode("FUNDING_FAILED"))).toBe(false);
    // The user declined a prompt — a decision, not a movement.
    expect(fundsMayBeInFlight(withCode(4001))).toBe(false);
    expect(fundsMayBeInFlight(withCode("WALLET_CHAIN_REJECTED"))).toBe(false);
  });

  it("says YES where a burn already landed", () => {
    expect(fundsMayBeInFlight(withCode("FUNDING_STUCK"))).toBe(true);
    expect(fundsMayBeInFlight(withCode("RESUMABLE"))).toBe(true);
    expect(fundsMayBeInFlight({ recoverability: "RESUMABLE" })).toBe(true);
  });

  it("reads through the wrapping the same way hasCode does", () => {
    const wrapped = Object.assign(new Error("bridge"), { cause: withCode("FUNDING_STUCK") });
    expect(fundsMayBeInFlight(wrapped)).toBe(true);
    const failed = Object.assign(new Error("bridge"), { cause: withCode("FUNDING_FAILED") });
    expect(fundsMayBeInFlight(failed)).toBe(false);
  });

  /**
   * The regression this exists for: a Gateway spend refused for want of a
   * balance never reaches a wallet, let alone a chain. It was reported as
   * possibly-in-flight, so the order was moved to `funding_pending` — a state
   * with no way back — and shown under "Funding never completed" with its pay
   * control gone. Nothing had moved. App Kit says so itself: `type: 'BALANCE'`
   * and `type: 'INPUT'` are decided before anything is signed.
   */
  it("says NO to App Kit's pre-flight refusals", () => {
    const insufficient = Object.assign(
      new Error("Insufficient USDC balance on Ethereum Sepolia. Available: 0 USDC, required: 13.208313 USDC"),
      { code: 9001, name: "BALANCE_INSUFFICIENT_TOKEN", type: "BALANCE", recoverability: "FATAL" },
    );
    expect(fundsMayBeInFlight(insufficient)).toBe(false);
    expect(fundsMayBeInFlight({ code: 9002, type: "BALANCE" })).toBe(false);
    expect(fundsMayBeInFlight({ code: 1003, type: "INPUT" })).toBe(false);
    // Wrapped the same way every other classification is read.
    expect(fundsMayBeInFlight(Object.assign(new Error("spend"), { cause: insufficient }))).toBe(false);
    // Our own plan refusing before a single intent is built.
    expect(fundsMayBeInFlight(withCode("GATEWAY_BALANCE_SHORT"))).toBe(false);
  });

  it("still says YES to the App Kit classes that CAN fail after a burn", () => {
    expect(fundsMayBeInFlight({ code: 5001, type: "ONCHAIN" })).toBe(true);
    expect(fundsMayBeInFlight({ code: 2001, type: "NETWORK" })).toBe(true);
  });

  it("defaults to YES for anything it does not recognise", () => {
    // Deliberate asymmetry: a wrong YES costs a stalled badge the retry path can
    // clear, a wrong NO invites a second burn.
    expect(fundsMayBeInFlight(new Error("HTTP request failed. Status: 403"))).toBe(true);
    expect(fundsMayBeInFlight(undefined)).toBe(true);
  });
});
