import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeTypedData, signPaymentIntent, type MessageToBeSigned } from "./cpn-sign.ts";

// Mirrors CPN's Permit2 PermitWitnessTransferFrom messageToBeSigned exactly as
// it arrives over JSON: chainId a string, uint256 fields as decimal strings AND
// a raw number (witness.value), a bytes32 hex nonce, a bool, and a nested struct.
function sampleMessage(from: string): MessageToBeSigned {
  return {
    domain: {
      name: "Permit2",
      chainId: "11155111",
      verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    },
    message: {
      permitted: { token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", amount: "14174474" },
      spender: "0xe2B17D0C1736dc7C462ABc4233C91BDb9F27DD1d",
      nonce: "25668617285137697861288274946631174355105919960416755114569514179393151588120",
      deadline: "1757362866",
      witness: {
        from,
        to: "0xc75c3e371d617b3e60db1b6f3fa2f0689562e5a7",
        value: 14174474,
        validAfter: "1757358106",
        validBefore: "1757361726",
        nonce: "0x38bfec2b230187932870d575132e8ae1f83b34c10e3bf6d64c377f0c13245718",
        beneficiary: "0x4f1c3a0359A7fAd8Fa8E9E872F7C06dAd97C91Fd",
        maxFee: "0",
        attester: "0x768919ef04853b5fd444ccff48cea154768a0291",
        requirePayeeSign: false,
      },
    },
    primaryType: "PermitWitnessTransferFrom",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      Witness: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "beneficiary", type: "address" },
        { name: "maxFee", type: "uint256" },
        { name: "attester", type: "address" },
        { name: "requirePayeeSign", type: "bool" },
      ],
    },
  };
}

describe("normalizeTypedData", () => {
  it("drops EIP712Domain, numbers chainId, and bigints every uint field", () => {
    const t = normalizeTypedData(sampleMessage("0x0000000000000000000000000000000000000001"));
    expect(t.types.EIP712Domain).toBeUndefined();
    expect(t.domain.chainId).toBe(11155111);
    const msg = t.message as any;
    expect(typeof msg.nonce).toBe("bigint");
    expect(msg.permitted.amount).toBe(14174474n); // string → bigint
    expect(msg.witness.value).toBe(14174474n); // number → bigint
    expect(msg.witness.maxFee).toBe(0n);
    expect(msg.witness.nonce).toBe("0x38bfec2b230187932870d575132e8ae1f83b34c10e3bf6d64c377f0c13245718"); // bytes32 kept
    expect(msg.witness.requirePayeeSign).toBe(false); // bool kept
  });
});

describe("signPaymentIntent", () => {
  it("produces a signature that recovers back to the signing account", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const message = sampleMessage(account.address);

    const signature = await signPaymentIntent(account, message);
    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const t = normalizeTypedData(message);
    const recovered = await recoverTypedDataAddress({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
      signature,
    } as never);
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
