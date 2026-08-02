/**
 * `pinnedTo` — making one wallet look like two chain-scoped wallets.
 *
 * This is the wrapper that exists because a live run cost real money to learn
 * its lesson: `createViemAdapterFromProvider` takes no chain argument, so
 * handing one adapter to both sides of a cross-chain move made App Kit send the
 * destination transaction on the SOURCE chain — and it failed AFTER the burn had
 * landed, stranding funds. Everything below guards that seam.
 *
 * The prompts themselves still need a human at a real wallet. What these tests
 * can pin down is what the code does with each ANSWER, which is where the
 * branches are.
 */
import { describe, expect, it } from "vitest";
import { ARC_CHAIN_PARAMS, pinnedTo, WalletChainRejected, type Eip1193 } from "./wallet-rails.ts";

const ARC = 5042002;
const SEPOLIA = 11155111;
const hex = (n: number) => `0x${n.toString(16)}`;

const ARC_PARAMS = { chainId: hex(ARC), chainName: "Arc Testnet" };

/** A wallet that starts on `startChain` and records what it was asked. */
function mockWallet(startChain: number, over: Partial<Record<string, unknown>> = {}) {
  let chain = startChain;
  const calls: string[] = [];
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => hex(chain),
    wallet_switchEthereumChain: (params) => {
      chain = Number((params[0] as { chainId: string }).chainId);
      return null;
    },
    eth_sendTransaction: () => "0xtx",
    ...(over as Record<string, (params: unknown[]) => unknown>),
  };
  const provider: Eip1193 = {
    async request({ method, params = [] }) {
      calls.push(method);
      const h = handlers[method];
      if (!h) throw new Error(`unmocked ${method}`);
      return h(params as unknown[]);
    },
  };
  return { provider, calls, get chain() { return chain; } };
}

const rejected = (code: number) => () => {
  const e = new Error("user rejected") as Error & { code: number };
  e.code = code;
  throw e;
};

describe("pinnedTo — reporting its own chain", () => {
  it("reports the pinned chain, not the wallet's", async () => {
    const w = mockWallet(SEPOLIA);
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);
    expect(await arc.request({ method: "eth_chainId" })).toBe(hex(ARC));
  });

  // Reads are NOT forced onto the pinned chain. A real wallet answers reads from
  // whatever chain it is on, and App Kit uses its own per-chain public clients
  // for chain-specific reads — so switching here would prompt the user for
  // nothing.
  it("does not switch the wallet just to read", async () => {
    const w = mockWallet(SEPOLIA);
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);
    await arc.request({ method: "eth_chainId" });
    expect(w.calls).not.toContain("wallet_switchEthereumChain");
    expect(w.chain).toBe(SEPOLIA);
  });
});

describe("pinnedTo — switching before it signs", () => {
  it("switches the wallet before a write", async () => {
    const w = mockWallet(SEPOLIA);
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    expect(await arc.request({ method: "eth_sendTransaction", params: [{}] })).toBe("0xtx");
    expect(w.calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction"]);
    expect(w.chain).toBe(ARC);
  });

  it("does not switch when the wallet is already there", async () => {
    const w = mockWallet(ARC);
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await arc.request({ method: "eth_sendTransaction", params: [{}] });
    expect(w.calls).not.toContain("wallet_switchEthereumChain");
  });

  // The two views share one wallet, so a cached "already on the right chain"
  // would be wrong the moment the other view switched it. That is the exact
  // shape of the bug this wrapper was written to fix.
  it("re-checks on every write rather than remembering", async () => {
    const w = mockWallet(SEPOLIA);
    const sep = pinnedTo(w.provider, SEPOLIA);
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await sep.request({ method: "eth_sendTransaction", params: [{}] }); // burn
    await arc.request({ method: "eth_sendTransaction", params: [{}] }); // mint
    expect(w.chain).toBe(ARC);
    await sep.request({ method: "eth_sendTransaction", params: [{}] }); // and back
    expect(w.chain).toBe(SEPOLIA);
  });
});

describe("pinnedTo — which calls pin the chain", () => {
  // The bug this guards: the gate used to be an allowlist of the two
  // `eth_send*` methods, so Gateway's EIP-712 burn intent went to the wallet on
  // whatever chain it happened to be on. A wallet refuses to sign typed data
  // for a chain it is not on — and refuses WITHOUT prompting, so the user saw
  // an error and no switch prompt at all.
  it("switches before signing typed data (Gateway burn intent)", async () => {
    const w = mockWallet(SEPOLIA, { eth_signTypedData_v4: () => "0xsig" });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await arc.request({ method: "eth_signTypedData_v4", params: ["0x1", "{}"] });
    expect(w.chain).toBe(ARC);
    expect(w.calls).toContain("wallet_switchEthereumChain");
  });

  it.each(["eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_getBalance"])(
    "switches before %s — a read answered by the wrong chain is a confident wrong answer",
    async (method) => {
      const w = mockWallet(SEPOLIA, { [method]: () => "0x0" });
      const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

      await arc.request({ method, params: [] });
      expect(w.chain).toBe(ARC);
    },
  );

  it("leaves account and permission plumbing alone — no prompt for those", async () => {
    const w = mockWallet(SEPOLIA, { eth_accounts: () => [], wallet_getPermissions: () => [] });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await arc.request({ method: "eth_accounts" });
    await arc.request({ method: "wallet_getPermissions" });
    expect(w.chain).toBe(SEPOLIA);
    expect(w.calls).not.toContain("wallet_switchEthereumChain");
  });

  it("answers chain queries from the pin, without touching the wallet", async () => {
    const w = mockWallet(SEPOLIA);
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    expect(await arc.request({ method: "eth_chainId" })).toBe(hex(ARC));
    expect(await arc.request({ method: "net_version" })).toBe(String(ARC));
    expect(w.chain).toBe(SEPOLIA); // still parked where it was
  });
});

describe("pinnedTo — a wallet that has never heard of Arc", () => {
  it("adds the chain when switching reports 4902", async () => {
    let chain = SEPOLIA;
    const added: unknown[] = [];
    const w = mockWallet(SEPOLIA, {
      eth_chainId: () => hex(chain),
      wallet_switchEthereumChain: (params: unknown[]) => {
        if (Number((params[0] as { chainId: string }).chainId) === ARC && !added.length) {
          const e = new Error("Unrecognized chain") as Error & { code: number };
          e.code = 4902;
          throw e;
        }
        chain = Number((params[0] as { chainId: string }).chainId);
        return null;
      },
      wallet_addEthereumChain: (params: unknown[]) => {
        added.push(params[0]);
        chain = ARC; // most wallets switch as part of adding
        return null;
      },
    });

    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);
    await arc.request({ method: "eth_sendTransaction", params: [{}] });

    expect(added).toEqual([ARC_PARAMS]);
    expect(chain).toBe(ARC);
  });

  // EIP-3085 does not promise that adding also switches. Assuming it does would
  // send the transaction on the old chain — the original bug, reintroduced
  // through the recovery path.
  it("switches explicitly when adding did not switch", async () => {
    let chain = SEPOLIA;
    let addCalled = false;
    const w = mockWallet(SEPOLIA, {
      eth_chainId: () => hex(chain),
      wallet_switchEthereumChain: (params: unknown[]) => {
        if (!addCalled) {
          const e = new Error("Unrecognized chain") as Error & { code: number };
          e.code = 4902;
          throw e;
        }
        chain = Number((params[0] as { chainId: string }).chainId);
        return null;
      },
      wallet_addEthereumChain: () => {
        addCalled = true;
        return null; // added, but stayed put
      },
    });

    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);
    await arc.request({ method: "eth_sendTransaction", params: [{}] });
    expect(chain).toBe(ARC);
  });

  // Real wallets do not reliably put the code at `error.code`. MetaMask hands
  // back -32603 with the real code buried in `data.originalError`, and this is
  // exactly what made a live add-chain attempt do nothing at all: the top-level
  // read saw an unknown fault and never tried EIP-3085.
  it("adds the chain when 4902 arrives nested under data.originalError", async () => {
    let chain = SEPOLIA;
    const added: unknown[] = [];
    const w = mockWallet(SEPOLIA, {
      eth_chainId: () => hex(chain),
      wallet_switchEthereumChain: (params: unknown[]) => {
        if (Number((params[0] as { chainId: string }).chainId) === ARC && !added.length) {
          const e = new Error("Internal JSON-RPC error.") as Error & { code: number; data: unknown };
          e.code = -32603;
          e.data = { originalError: { code: 4902, message: "Unrecognized chain ID" } };
          throw e;
        }
        chain = Number((params[0] as { chainId: string }).chainId);
        return null;
      },
      wallet_addEthereumChain: (params: unknown[]) => {
        added.push(params[0]);
        chain = ARC;
        return null;
      },
    });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await arc.request({ method: "eth_sendTransaction", params: [{}] });
    expect(added).toHaveLength(1);
    expect(chain).toBe(ARC);
  });

  it("adds the chain when the wallet only says so in the message", async () => {
    let chain = SEPOLIA;
    const added: unknown[] = [];
    const w = mockWallet(SEPOLIA, {
      eth_chainId: () => hex(chain),
      wallet_switchEthereumChain: (params: unknown[]) => {
        if (Number((params[0] as { chainId: string }).chainId) === ARC && !added.length) {
          // No code at all — some wallets describe it and nothing more.
          throw new Error("Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.");
        }
        chain = Number((params[0] as { chainId: string }).chainId);
        return null;
      },
      wallet_addEthereumChain: (params: unknown[]) => {
        added.push(params[0]);
        chain = ARC;
        return null;
      },
    });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await arc.request({ method: "eth_sendTransaction", params: [{}] });
    expect(added).toHaveLength(1);
    expect(chain).toBe(ARC);
  });

  it("offers every fallback RPC when adding, not just the primary", () => {
    // A wallet validates the chain by calling the RPC itself, and Arc's public
    // endpoint rate-limits hard enough to refuse — which surfaces as a plain
    // "could not add the network". EIP-3085 takes a list; give it the list.
    expect(ARC_CHAIN_PARAMS.rpcUrls.length).toBeGreaterThan(1);
    expect(ARC_CHAIN_PARAMS.nativeCurrency.decimals).toBe(18); // USDC as gas, not as ERC-20
  });

  it("propagates 4902 when there are no chain params to add with", async () => {
    const w = mockWallet(SEPOLIA, { wallet_switchEthereumChain: rejected(4902) });
    const arc = pinnedTo(w.provider, ARC); // no addParams
    await expect(arc.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow(/Unrecognized|user rejected/);
  });
});

describe("pinnedTo — the user says no", () => {
  it("turns a declined switch into WalletChainRejected", async () => {
    const w = mockWallet(SEPOLIA, { wallet_switchEthereumChain: rejected(4001) });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    await expect(arc.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow(WalletChainRejected);
    // Nothing was signed — that is the part a UI must be able to say.
    expect(w.calls).not.toContain("eth_sendTransaction");
  });

  it("names the chain and the action so a UI can ask again", async () => {
    const w = mockWallet(SEPOLIA, { wallet_switchEthereumChain: rejected(4001) });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    const err = (await arc
      .request({ method: "eth_sendTransaction", params: [{}] })
      .catch((e) => e)) as WalletChainRejected;
    expect(err).toBeInstanceOf(WalletChainRejected);
    expect(err.action).toBe("switch");
    expect(err.message).toContain("Arc Testnet");
    expect(err.message).toContain("Nothing was signed");
  });

  it("distinguishes a declined ADD from a declined switch", async () => {
    const w = mockWallet(SEPOLIA, {
      wallet_switchEthereumChain: rejected(4902),
      wallet_addEthereumChain: rejected(4001),
    });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);

    const err = (await arc
      .request({ method: "eth_sendTransaction", params: [{}] })
      .catch((e) => e)) as WalletChainRejected;
    expect(err).toBeInstanceOf(WalletChainRejected);
    expect(err.action).toBe("add");
  });

  it("lets a genuine wallet failure through unchanged", async () => {
    const w = mockWallet(SEPOLIA, { wallet_switchEthereumChain: rejected(-32603) });
    const arc = pinnedTo(w.provider, ARC, ARC_PARAMS);
    await expect(arc.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow(/user rejected/);
    // Not wrapped: only 4001 is a decision, everything else is a fault.
    await expect(arc.request({ method: "eth_sendTransaction", params: [{}] })).rejects.not.toBeInstanceOf(WalletChainRejected);
  });
});
