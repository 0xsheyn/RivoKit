import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_SPEND_FEE_MINOR,
  GatewayBalanceShortError,
  createUnifiedBalance,
  planAllocations,
  type UbChainBalance,
} from "./unified-balance.ts";

const chain = (name: string, confirmed: bigint, pending = 0n): UbChainBalance => ({
  chain: name,
  confirmedMinor: confirmed,
  pendingMinor: pending,
});

describe("planAllocations", () => {
  it("draws the whole amount from the preferred chain when it can carry it", () => {
    const plan = planAllocations(
      [chain("Avalanche_Fuji", 50_000_000n), chain("Ethereum_Sepolia", 40_000_000n)],
      12_000_000n,
      { prefer: "Ethereum_Sepolia" },
    );
    expect(plan).toEqual([{ chain: "Ethereum_Sepolia", amountMinor: 12_000_000n }]);
  });

  /**
   * The bug this whole function exists for. The payer picked Ethereum Sepolia,
   * the UI showed the chain-abstracted total, and the deposit was on Fuji — so
   * a spend pinned to the picked chain was refused with "Available: 0 USDC"
   * against a balance the screen called available.
   */
  it("falls through to the chains that actually hold the balance", () => {
    const plan = planAllocations(
      [chain("Ethereum_Sepolia", 0n), chain("Avalanche_Fuji", 20_000_000n)],
      13_000_000n,
      { prefer: "Ethereum_Sepolia" },
    );
    expect(plan).toEqual([{ chain: "Avalanche_Fuji", amountMinor: 13_000_000n }]);
  });

  it("splits across chains, preferred first, when no single one is enough", () => {
    const plan = planAllocations(
      [chain("Avalanche_Fuji", 6_000_000n), chain("Base_Sepolia", 9_000_000n)],
      12_000_000n,
      { prefer: "Avalanche_Fuji" },
    );
    // Fuji contributes its balance minus the fee it must keep back; Base covers
    // the rest.
    expect(plan).toEqual([
      { chain: "Avalanche_Fuji", amountMinor: 5_000_000n },
      { chain: "Base_Sepolia", amountMinor: 7_000_000n },
    ]);
    expect(plan.reduce((s, a) => s + a.amountMinor, 0n)).toBe(12_000_000n);
  });

  it("takes the largest balances first when nothing is preferred", () => {
    const plan = planAllocations(
      [chain("Avalanche_Fuji", 3_000_000n), chain("Base_Sepolia", 30_000_000n)],
      2_500_000n,
    );
    expect(plan).toEqual([{ chain: "Base_Sepolia", amountMinor: 2_500_000n }]);
  });

  /**
   * Gateway adds its fee to the burn instead of taking it out, and charges it
   * per intent — so a chain holding exactly the amount is one fee short. This
   * is the "available 12.208313, required 13.208313" refusal, caught locally.
   */
  it("keeps the spend fee back on every chain it draws from", () => {
    expect(() => planAllocations([chain("Base_Sepolia", 12_000_000n)], 12_000_000n))
      .toThrow(GatewayBalanceShortError);
    expect(planAllocations([chain("Base_Sepolia", 12_000_000n + GATEWAY_SPEND_FEE_MINOR)], 12_000_000n))
      .toEqual([{ chain: "Base_Sepolia", amountMinor: 12_000_000n }]);
  });

  it("ignores a chain that cannot even cover the fee", () => {
    const plan = planAllocations(
      [chain("Ethereum_Sepolia", 500_000n), chain("Base_Sepolia", 20_000_000n)],
      4_000_000n,
      { prefer: "Ethereum_Sepolia" },
    );
    expect(plan).toEqual([{ chain: "Base_Sepolia", amountMinor: 4_000_000n }]);
  });

  it("refuses with the usable total, not the raw one — the difference is the fee", () => {
    try {
      planAllocations([chain("Base_Sepolia", 5_000_000n)], 9_000_000n);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayBalanceShortError);
      const err = e as GatewayBalanceShortError;
      expect(err.requiredMinor).toBe(9_000_000n);
      expect(err.usableMinor).toBe(4_000_000n);
      expect(err.message).toContain("Base_Sepolia 5");
    }
  });

  it("says plainly when there is nothing confirmed at all", () => {
    expect(() => planAllocations([chain("Base_Sepolia", 0n)], 1_000_000n))
      .toThrow(/nothing confirmed/);
  });
});

// Minimal App Kit stand-in — only what createUnifiedBalance touches.
function mockKit(over: { getBalances?: unknown; spend?: unknown } = {}) {
  return {
    unifiedBalance: {
      getBalances: over.getBalances ?? vi.fn(),
      deposit: vi.fn(),
      spend: over.spend ?? vi.fn(async () => ({ txHash: "0xspend", recipientAddress: "0xrec" })),
    },
  } as never;
}

const BALANCES = {
  token: "USDC",
  totalConfirmedBalance: "21.000000",
  totalPendingBalance: "3.000000",
  breakdown: [
    {
      depositor: "0xdep",
      totalConfirmed: "21.000000",
      totalPending: "3.000000",
      breakdown: [
        { chain: "Ethereum_Sepolia", confirmedBalance: "0.000000", pendingBalance: "3.000000" },
        { chain: "Avalanche_Fuji", confirmedBalance: "21.000000", pendingBalance: "0.000000" },
      ],
    },
  ],
};

describe("getBalance", () => {
  it("reports the total AND the per-chain split a spend can name", async () => {
    const kit = mockKit({ getBalances: vi.fn(async () => BALANCES) });
    const bal = await createUnifiedBalance(kit).getBalance({});
    expect(bal.confirmedMinor).toBe(21_000_000n);
    expect(bal.pendingMinor).toBe(3_000_000n);
    expect(bal.byChain).toEqual([
      { chain: "Ethereum_Sepolia", confirmedMinor: 0n, pendingMinor: 3_000_000n },
      { chain: "Avalanche_Fuji", confirmedMinor: 21_000_000n, pendingMinor: 0n },
    ]);
  });

  it("adds up two depositors holding a balance on the same chain", async () => {
    const kit = mockKit({
      getBalances: vi.fn(async () => ({
        totalConfirmedBalance: "7.000000",
        breakdown: [
          { depositor: "0xa", breakdown: [{ chain: "Base_Sepolia", confirmedBalance: "3.000000" }] },
          { depositor: "0xb", breakdown: [{ chain: "Base_Sepolia", confirmedBalance: "4.000000" }] },
        ],
      })),
    });
    const bal = await createUnifiedBalance(kit).getBalance({});
    expect(bal.byChain).toEqual([{ chain: "Base_Sepolia", confirmedMinor: 7_000_000n, pendingMinor: 0n }]);
  });
});

describe("spend", () => {
  it("passes explicit allocations through as decimal strings", async () => {
    const spend = vi.fn(async () => ({ txHash: "0xspend", recipientAddress: "0xrec" }));
    await createUnifiedBalance(mockKit({ spend })).spend({
      fromAdapter: {},
      allocations: [
        { chain: "Avalanche_Fuji", amountMinor: 5_000_000n },
        { chain: "Base_Sepolia", amountMinor: 7_000_000n },
      ],
      toAdapter: {},
      toChain: "Arc_Testnet",
      amountMinor: 12_000_000n,
    });
    expect(spend).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "12",
        from: expect.objectContaining({
          allocations: [
            { amount: "5", chain: "Avalanche_Fuji" },
            { amount: "7", chain: "Base_Sepolia" },
          ],
        }),
      }),
    );
  });

  it("still accepts the single-chain shorthand", async () => {
    const spend = vi.fn(async () => ({ txHash: "0xspend", recipientAddress: "0xrec" }));
    await createUnifiedBalance(mockKit({ spend })).spend({
      fromAdapter: {}, fromChain: "Base_Sepolia",
      toAdapter: {}, toChain: "Arc_Testnet", amountMinor: 2_000_000n,
    });
    expect(spend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.objectContaining({ allocations: [{ amount: "2", chain: "Base_Sepolia" }] }),
      }),
    );
  });

  it("prefers allocations over fromChain when both are given", async () => {
    const spend = vi.fn(async () => ({ txHash: "0xspend", recipientAddress: "0xrec" }));
    await createUnifiedBalance(mockKit({ spend })).spend({
      fromAdapter: {}, fromChain: "Ethereum_Sepolia",
      allocations: [{ chain: "Avalanche_Fuji", amountMinor: 2_000_000n }],
      toAdapter: {}, toChain: "Arc_Testnet", amountMinor: 2_000_000n,
    });
    expect(spend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.objectContaining({ allocations: [{ amount: "2", chain: "Avalanche_Fuji" }] }),
      }),
    );
  });
});
