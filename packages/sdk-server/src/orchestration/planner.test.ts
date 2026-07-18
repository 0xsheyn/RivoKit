import { describe, expect, it } from "vitest";
import { plan } from "./planner.js";

const usdcOnArc = { currency: "USD", form: "stablecoin", location: "arc" } as const;

describe("planner", () => {
  it("USDC in-app → USD stablecoin in-app = P2P, tanpa hub", () => {
    const p = plan({
      source: usdcOnArc,
      destination: { currency: "USD", form: "stablecoin" },
      destinationLocation: "arc",
      constraints: { needsEscrow: false },
    });
    expect(p.hubRequired).toBe(false);
    expect(p.legs.map((l) => l.type)).toEqual(["p2p"]);
  });

  it("USDC → EUR fiat = escrow → fx → offramp, offramp terakhir", () => {
    const p = plan({
      source: usdcOnArc,
      destination: { currency: "EUR", form: "fiat" },
      destinationLocation: "bank",
      constraints: { needsEscrow: true },
    });
    expect(p.legs.map((l) => l.type)).toEqual(["escrow", "fx", "offramp"]);
    expect(p.legs.at(-1)?.reversibility).toBe("irreversible");
  });

  it("escrow menahan mata uang SUMBER — FX terjadi setelahnya", () => {
    const p = plan({
      source: usdcOnArc,
      destination: { currency: "EUR", form: "fiat" },
      destinationLocation: "bank",
      constraints: { needsEscrow: true },
    });
    const escrowLeg = p.legs.find((l) => l.type === "escrow");
    expect(escrowLeg?.to.currency).toBe("USD");
  });

  it("USD fiat ke bank tidak menyisipkan leg FX", () => {
    const p = plan({
      source: usdcOnArc,
      destination: { currency: "USD", form: "fiat" },
      destinationLocation: "bank",
      constraints: { needsEscrow: true },
    });
    expect(p.legs.map((l) => l.type)).toEqual(["escrow", "offramp"]);
  });

  it("USDC@Base → EUR fiat = bridge ingress dulu", () => {
    const p = plan({
      source: { currency: "USD", form: "stablecoin", location: "base" },
      destination: { currency: "EUR", form: "fiat" },
      destinationLocation: "bank",
      constraints: { needsEscrow: true },
    });
    expect(p.legs.map((l) => l.type)).toEqual(["bridge", "escrow", "fx", "offramp"]);
  });

  it("planner murni — input sama menghasilkan plan sama", () => {
    const input = {
      source: usdcOnArc,
      destination: { currency: "EUR", form: "fiat" },
      destinationLocation: "bank",
      constraints: { needsEscrow: true },
    } as const;
    expect(plan(input)).toEqual(plan(input));
  });
});
