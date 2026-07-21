import { describe, expect, it, vi } from "vitest";
import { createEmitter } from "./emitter.ts";

describe("emitter — subscribe / emit", () => {
  it("delivers a payload to a subscribed handler", () => {
    const e = createEmitter();
    const seen: unknown[] = [];
    e.on("funded", (p) => seen.push(p));
    e.emit("funded", { orderId: "o1" });
    expect(seen).toEqual([{ orderId: "o1" }]);
  });

  it("stops delivering after off() / the returned unsubscribe", () => {
    const e = createEmitter();
    const h = vi.fn();
    const unsub = e.on("funded", h);
    unsub();
    e.emit("funded", { orderId: "o1" });
    expect(h).not.toHaveBeenCalled();
  });

  it("isolates a throwing handler so others still run", () => {
    const e = createEmitter();
    const good = vi.fn();
    e.on("funded", () => {
      throw new Error("host handler bug");
    });
    e.on("funded", good);
    expect(() => e.emit("funded", { orderId: "o1" })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});

describe("emitForState", () => {
  it("emits the event whose name matches the state", () => {
    const e = createEmitter();
    const h = vi.fn();
    e.on("refunded", h);
    const name = e.emitForState("refunded", { orderId: "o1", chain: "Ethereum_Sepolia" });
    expect(name).toBe("refunded");
    expect(h).toHaveBeenCalledWith({ orderId: "o1", chain: "Ethereum_Sepolia" });
  });

  it("emits nothing for states with no host-facing event", () => {
    const e = createEmitter();
    for (const silent of ["created", "settlement_pending", "shipped"] as const) {
      expect(e.emitForState(silent, { orderId: "o1" } as never)).toBeNull();
    }
  });
});
