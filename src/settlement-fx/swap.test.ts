/**
 * `lockQuote` is the only thing between a checkout and a settlement that cannot
 * be undone, so what it asks the market — and at what size — is worth pinning.
 *
 * App Kit is mocked at the module boundary because `createSettlementFx` builds
 * its own `AppKit` and its own Circle Wallets adapter; neither is injectable,
 * and neither should be, since a host has no business supplying them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estimateSwap = vi.fn();
const swap = vi.fn();

vi.mock("@circle-fin/app-kit", () => ({
  AppKit: class {
    estimateSwap = estimateSwap;
    swap = swap;
  },
  SwapChain: { Arc_Testnet: "Arc_Testnet" },
}));
vi.mock("@circle-fin/adapter-circle-wallets", () => ({
  createCircleWalletsAdapter: () => ({}),
}));

const { NoRouteError, createSettlementFx } = await import("./swap.ts");

const fx = createSettlementFx({ kitKey: "k", circleApiKey: "a", circleEntitySecret: "s" });
const ADDRESS = "0xmerchant";

/** A market quoting `rate` EURC per USDC, but only up to `ceilingMinor`. */
const marketWithCeiling = (rate: number, ceilingMinor: bigint) =>
  vi.fn(async ({ amountIn }: { amountIn: string }) => {
    const inMinor = BigInt(Math.round(Number(amountIn) * 1e6));
    if (inMinor > ceilingMinor) throw new Error("no route available");
    return {
      estimatedOutput: { amount: (Number(amountIn) * rate).toFixed(6), token: "EURC" },
      stopLimit: { amount: (Number(amountIn) * rate * 0.97).toFixed(6) },
      fees: [],
    };
  });

const lock = (priceOutMinor: bigint, bufferBps = 150) =>
  fx.lockQuote({
    address: ADDRESS, tokenIn: "USDC", tokenOut: "EURC",
    priceOutMinor, bufferBps, probeInMinor: priceOutMinor,
  });

beforeEach(() => {
  estimateSwap.mockReset();
  swap.mockReset();
});

describe("lockQuote", () => {
  it("re-quotes at the size it derived, not at the probe", async () => {
    estimateSwap.mockImplementation(marketWithCeiling(0.75, 1_000_000_000n));
    const { amountInMinor } = await lock(9_000_000n);

    expect(estimateSwap).toHaveBeenCalledTimes(2);
    // First pass asks about €9 worth of USDC; the second asks about the ~12.2
    // USDC the swap will actually move.
    expect(estimateSwap.mock.calls[0]![0].amountIn).toBe("9");
    expect(Number(estimateSwap.mock.calls[1]![0].amountIn)).toBeCloseTo(12.18, 2);
    // 9 / 0.75 = 12, plus 150 bps.
    expect(amountInMinor).toBe(12_180_000n);
  });

  /**
   * The failure this two-pass shape exists to prevent, measured live on Arc
   * Testnet on 2026-08-07: USDC→EURC quoted cleanly at 9.80 USDC and returned
   * "no route available" at 10.00. A €9.00 order probes at 9 — under the
   * ceiling — and settles at ~12.2, over it. Before this, that order passed
   * checkout, took the payer's USDC, captured the escrow, and only then failed
   * its swap, landing in `settlement_pending`.
   */
  it("refuses at checkout when the DERIVED size has no route, though the probe did", async () => {
    estimateSwap.mockImplementation(marketWithCeiling(0.75, 9_800_000n));
    await expect(lock(9_000_000n)).rejects.toBeInstanceOf(NoRouteError);
    // It got as far as asking the second question — the probe succeeded.
    expect(estimateSwap).toHaveBeenCalledTimes(2);
  });

  it("names the size that was refused, since the pair itself is fine", async () => {
    estimateSwap.mockImplementation(marketWithCeiling(0.75, 9_800_000n));
    await expect(lock(9_000_000n)).rejects.toThrow(/12\.18 USDC/);
  });

  it("still serves a size the market does reach", async () => {
    estimateSwap.mockImplementation(marketWithCeiling(0.75, 9_800_000n));
    const { amountInMinor } = await lock(6_500_000n);
    // 6.5 / 0.75 * 1.015 — to the cent, the fake market rounds its own output.
    expect(Number(amountInMinor) / 1e6).toBeCloseTo(8.7967, 3);
  });

  it("prices off the SECOND quote — it is the one sampled where the trade lands", async () => {
    // A market that pays worse as size grows: probe at 9 sees 0.80, the real
    // size sees 0.75. Pricing off the probe would under-fund the floor.
    estimateSwap.mockImplementation(async ({ amountIn }: { amountIn: string }) => {
      const rate = Number(amountIn) < 10 ? 0.8 : 0.75;
      return {
        estimatedOutput: { amount: (Number(amountIn) * rate).toFixed(6), token: "EURC" },
        stopLimit: null, fees: [],
      };
    });
    const { amountInMinor, quote } = await lock(9_000_000n);
    // 9 / 0.75 * 1.015 = 12.18, not 9 / 0.80 * 1.015 = 11.4187.
    expect(Number(amountInMinor) / 1e6).toBeCloseTo(12.18, 3);
    expect(quote.amountInMinor).toBe(11_418_750n);
  });

  it("does not ask twice when the probe was already the right size", async () => {
    // rate 1.0 and no buffer: the derived amount equals the probe.
    estimateSwap.mockImplementation(marketWithCeiling(1, 1_000_000_000n));
    const { amountInMinor } = await fx.lockQuote({
      address: ADDRESS, tokenIn: "USDC", tokenOut: "EURC",
      priceOutMinor: 5_000_000n, bufferBps: 0, probeInMinor: 5_000_000n,
    });
    expect(amountInMinor).toBe(5_000_000n);
    expect(estimateSwap).toHaveBeenCalledTimes(1);
  });
});

describe("no-route classification", () => {
  it("treats 'insufficient liquidity' as the same answer as 'no route'", async () => {
    // Two ways the service says "not at this size": no maker answered, or one
    // answered and could not fill it. Untyped, the second used to surface as a
    // bare settlement failure — or, once stopLimit turned it into a slippage
    // complaint, as a floor that was never the problem.
    estimateSwap.mockRejectedValue(
      new Error("Stablecoin Service createSwap failed: Insufficient liquidity for the requested swap. Try a smaller amount or retry shortly."),
    );
    await expect(
      fx.quote({ address: ADDRESS, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: 12_000_000n }),
    ).rejects.toBeInstanceOf(NoRouteError);
  });

  it("leaves an unrelated failure unclassified", async () => {
    estimateSwap.mockRejectedValue(new Error("HTTP request failed. Status: 503"));
    await expect(
      fx.quote({ address: ADDRESS, tokenIn: "USDC", tokenOut: "EURC", amountInMinor: 1_000_000n }),
    ).rejects.toThrow(/503/);
  });
});
