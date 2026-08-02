/**
 * The source-chain table, and the one rule that costs money when it is wrong.
 *
 * A row can be present and still be unusable — Polygon Amoy is exactly that: the
 * CCTP burn reverts from it, while `estimateBridge` happily says the route is
 * fine. Nothing upstream reports it as broken, so the table is the only place
 * that can, and these tests are what keep that guard from quietly rotting into
 * decoration (see the "rules written but not wired" note in memory).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_CHAIN_ID,
  ENABLED_SOURCE_CHAINS,
  SOURCE_CHAIN,
  SOURCE_CHAINS,
  sourceChain,
  sourceChainByName,
  sourceChainParams,
  usableSourceChain,
} from "./source-chain.ts";

describe("the table itself", () => {
  it("has unique keys, chain ids and App Kit names", () => {
    for (const field of ["key", "id", "name"] as const) {
      const seen = SOURCE_CHAINS.map((c) => c[field]);
      expect(new Set(seen).size, `duplicate ${field}`).toBe(seen.length);
    }
  });

  it("gives every chain at least one RPC endpoint and a distinct explorer", () => {
    for (const c of SOURCE_CHAINS) {
      expect(c.rpcUrls.length, `${c.key} has no RPC endpoint`).toBeGreaterThan(0);
      for (const url of c.rpcUrls) expect(url.startsWith("https://"), `${c.key}: ${url}`).toBe(true);
      expect(c.explorerUrl.startsWith("https://")).toBe(true);
    }
  });

  it("never lists Arc's own USDC address as a source token", () => {
    // Arc is the destination, and its USDC is the gas token. A row carrying that
    // address would mean a burn pointed at the wrong chain entirely.
    for (const c of SOURCE_CHAINS) {
      expect(c.usdc.toLowerCase()).not.toBe("0x3600000000000000000000000000000000000000");
    }
  });
});

describe("disabled chains", () => {
  it("keeps Amoy in the table but out of the usable set", () => {
    // Kept deliberately: the row carries the work needed to finish the rail.
    const amoy = SOURCE_CHAINS.find((c) => c.key === "amoy");
    expect(amoy, "the Amoy row must survive — it is disabled, not deleted").toBeDefined();
    expect(amoy?.disabledReason).toBeTruthy();
    expect(ENABLED_SOURCE_CHAINS.map((c) => c.key)).not.toContain("amoy");
  });

  it("refuses to hand back a disabled chain to a money-moving caller", () => {
    expect(() => usableSourceChain("amoy")).toThrow(/disabled/i);
  });

  it("names the chain and the reason when it refuses", () => {
    // The message reaches a human, so it has to say which chain and why rather
    // than just failing.
    expect(() => usableSourceChain("amoy")).toThrow(/Polygon Amoy/);
    expect(() => usableSourceChain("amoy")).toThrow(/burn/i);
  });

  it("still resolves a disabled chain for display and explorer links", () => {
    // Balances and recorded transactions on a disabled chain must stay readable.
    expect(sourceChain("amoy").label).toBe("Polygon Amoy");
    expect(sourceChainByName("Polygon_Amoy_Testnet")?.key).toBe("amoy");
  });

  it("does NOT substitute the default for a disabled chain", () => {
    // The whole point: silently falling back would approve on the chain the
    // payer picked and burn on another one.
    expect(() => usableSourceChain("amoy")).toThrow();
    expect(usableSourceChain(undefined).key).toBe(DEFAULT_SOURCE_CHAIN_ID);
  });

  it("leaves every enabled chain usable", () => {
    for (const c of ENABLED_SOURCE_CHAINS) {
      expect(usableSourceChain(c.key).key).toBe(c.key);
    }
  });
});

describe("defaults", () => {
  it("defaults to a chain that is itself enabled", () => {
    // A disabled default would break every rail at once.
    expect(SOURCE_CHAIN.disabledReason).toBeUndefined();
    expect(ENABLED_SOURCE_CHAINS.map((c) => c.key)).toContain(DEFAULT_SOURCE_CHAIN_ID);
    expect(SOURCE_CHAIN.key).toBe(DEFAULT_SOURCE_CHAIN_ID);
  });

  it("falls back to the default for an unknown key rather than throwing", () => {
    expect(sourceChain("nope").key).toBe(DEFAULT_SOURCE_CHAIN_ID);
    expect(sourceChain(null).key).toBe(DEFAULT_SOURCE_CHAIN_ID);
  });
});

describe("wallet_addEthereumChain params", () => {
  it("passes every endpoint, not just the first", () => {
    // A wallet validates an added chain by calling the RPC itself; one dead
    // endpoint reads to the user as "could not add the network".
    for (const c of SOURCE_CHAINS) {
      expect(sourceChainParams(c).rpcUrls).toEqual([...c.rpcUrls]);
    }
  });

  it("encodes the chain id as hex", () => {
    expect(sourceChainParams(sourceChain("amoy")).chainId).toBe("0x13882");
    expect(Number(sourceChainParams(SOURCE_CHAIN).chainId)).toBe(SOURCE_CHAIN.id);
  });
});
