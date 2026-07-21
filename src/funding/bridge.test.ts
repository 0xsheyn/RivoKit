import { describe, expect, it, vi } from "vitest";
import { createBridge, BridgeStuckError, BridgeFailedError, type BridgeParams } from "./bridge.ts";

const params = {
  fromAdapter: {}, fromChain: "Arc_Testnet", toAdapter: {}, toChain: "Ethereum_Sepolia",
  amountMinor: 2_000_000n, kitKey: "k",
} as unknown as BridgeParams;

// Minimal AppKit stand-in — only the methods createBridge touches.
function mockKit(over: { bridge?: unknown; retryBridge?: unknown } = {}) {
  return {
    bridge: over.bridge ?? vi.fn(),
    retryBridge: over.retryBridge ?? vi.fn(),
  } as never;
}

const SUCCESS = {
  state: "success",
  steps: [
    { name: "approve", state: "success", txHash: "0xapp" },
    { name: "burn", state: "success", txHash: "0xburn" },
    { name: "mint", state: "success", txHash: "0xmint" },
  ],
};

describe("bridge.execute", () => {
  it("returns burn+mint hashes on a completed transfer", async () => {
    const kit = mockKit({ bridge: vi.fn(async () => SUCCESS) });
    const res = await createBridge(kit).execute(params);
    expect(res).toMatchObject({ state: "success", burnTxHash: "0xburn", mintTxHash: "0xmint" });
  });

  it("throws BridgeFailedError when it errors BEFORE burning (nothing moved)", async () => {
    const kit = mockKit({
      bridge: vi.fn(async () => ({ state: "error", steps: [{ name: "burn", state: "error", errorMessage: "gas" }] })),
    });
    await expect(createBridge(kit).execute(params)).rejects.toBeInstanceOf(BridgeFailedError);
  });

  it("throws BridgeStuckError once burn succeeded, carrying the result for retry", async () => {
    const stuck = { state: "error", steps: [{ name: "burn", state: "success", txHash: "0xb" }, { name: "mint", state: "error" }] };
    const kit = mockKit({ bridge: vi.fn(async () => stuck) });
    await expect(createBridge(kit).execute(params)).rejects.toMatchObject({
      code: "FUNDING_STUCK",
      detail: stuck, // usable as `previous` for retry
    });
  });

  it("maps a thrown attestation timeout to BridgeStuckError (funds may be in flight)", async () => {
    const kit = mockKit({ bridge: vi.fn(async () => { throw new Error("attestation timeout after 10 tries"); }) });
    await expect(createBridge(kit).execute(params)).rejects.toBeInstanceOf(BridgeStuckError);
  });

  it("maps a thrown network failure to BridgeFailedError (nothing moved, DNS-suspect)", async () => {
    const kit = mockKit({ bridge: vi.fn(async () => { throw new Error("fetch failed"); }) });
    await expect(createBridge(kit).execute(params)).rejects.toMatchObject({ code: "FUNDING_FAILED", networkSuspected: true });
  });
});

describe("bridge.retry — resume, never resend", () => {
  it("resumes via kit.retryBridge (NOT kit.bridge) and returns the completed result", async () => {
    const bridge = vi.fn();
    const retryBridge = vi.fn(async () => SUCCESS);
    const kit = mockKit({ bridge, retryBridge });
    const prev = { state: "pending", steps: [{ name: "burn", state: "success", txHash: "0xb" }] };

    const res = await createBridge(kit).retry(params, prev);

    expect(res).toMatchObject({ state: "success", mintTxHash: "0xmint" });
    expect(retryBridge).toHaveBeenCalledOnce();
    expect(bridge).not.toHaveBeenCalled(); // the whole point: no second burn
  });

  it("stays BridgeStuckError if the retry is still not attested — still no re-burn", async () => {
    const retryBridge = vi.fn(async () => ({ state: "pending", steps: [{ name: "burn", state: "success" }] }));
    const kit = mockKit({ retryBridge });
    await expect(createBridge(kit).retry(params, {})).rejects.toBeInstanceOf(BridgeStuckError);
  });
});
