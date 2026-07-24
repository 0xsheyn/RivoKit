import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { receiveAuthorizationTypedData } from "./erc3009.ts";
import { getPayerAgnosticHash, type PaymentInfo } from "./payment-info.ts";

// Public test key (Anvil #0). Only used to sign/recover a testnet-shaped payload.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const CHAIN_ID = 5042002;
const ESCROW = "0x4444444444444444444444444444444444444444" as const;
const COLLECTOR = "0x5555555555555555555555555555555555555555" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;

const pi: PaymentInfo = {
  operator: "0x3333333333333333333333333333333333333333",
  payer: account.address,
  receiver: "0x2222222222222222222222222222222222222222",
  token: USDC,
  maxAmount: 2_000_000n,
  preApprovalExpiry: 1_800_000_000,
  authorizationExpiry: 1_900_000_000,
  refundExpiry: 2_000_000_000,
  minFeeBps: 0,
  maxFeeBps: 0,
  feeReceiver: "0x0000000000000000000000000000000000000000",
  salt: 42n,
};

const td = receiveAuthorizationTypedData({ paymentInfo: pi, chainId: CHAIN_ID, escrowAddress: ESCROW, tokenCollector: COLLECTOR, usdcAddress: USDC });

describe("receiveAuthorizationTypedData", () => {
  it("targets Arc USDC's EIP-712 domain", () => {
    expect(td.domain).toEqual({ name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC });
  });

  it("authorizes maxAmount to the token collector, bounded by preApprovalExpiry", () => {
    expect(td.message.from).toBe(account.address);
    expect(td.message.to).toBe(COLLECTOR);
    expect(td.message.value).toBe(2_000_000n);
    expect(td.message.validAfter).toBe(0n);
    expect(td.message.validBefore).toBe(BigInt(pi.preApprovalExpiry));
  });

  it("uses the PAYER-AGNOSTIC hash as the single-use nonce (replay protection)", () => {
    expect(td.message.nonce).toBe(getPayerAgnosticHash(pi, CHAIN_ID, ESCROW));
    // The nonce must NOT depend on the payer — zeroing it changes nothing.
    expect(td.message.nonce).toBe(getPayerAgnosticHash({ ...pi, payer: "0x9999999999999999999999999999999999999999" }, CHAIN_ID, ESCROW));
  });

  it("produces a signature that recovers to the payer — gasless, no tx from the buyer", async () => {
    const signature = await account.signTypedData(td);
    const recovered = await recoverTypedDataAddress({ ...td, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("binds to the chain: a signature does not verify under a different chainId", async () => {
    const signature = await account.signTypedData(td);
    const otherChain = receiveAuthorizationTypedData({ paymentInfo: pi, chainId: 1, escrowAddress: ESCROW, tokenCollector: COLLECTOR, usdcAddress: USDC });
    const recovered = await recoverTypedDataAddress({ ...otherChain, signature });
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });
});
