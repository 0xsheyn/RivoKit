import { describe, expect, it, vi } from "vitest";
import { createRivoKit, type RivoKitDeps } from "./rivokit.ts";
import { createEmitter } from "../events/emitter.ts";
import { FloorNotMetError } from "../settlement-fx/swap.ts";
import { BridgeStuckError } from "../funding/bridge.ts";
import type { OrderRecord } from "../orchestrator/order-store.ts";

const ADDR = {
  payer: "0x1111111111111111111111111111111111111111",
  receiver: "0x2222222222222222222222222222222222222222",
  operator: "0x3333333333333333333333333333333333333333",
  token: "0x3600000000000000000000000000000000000000",
  escrow: "0x4444444444444444444444444444444444444444",
  refundCollector: "0x5555555555555555555555555555555555555555",
} as const;

const NOW = 1_700_000_000;

function mkOrder(o: Partial<OrderRecord> = {}): OrderRecord {
  const iso = new Date((NOW + 3600) * 1000).toISOString();
  return {
    id: "ord_x", payer: ADDR.payer, receiver: ADDR.receiver, operator: ADDR.operator, token: ADDR.token,
    price_eur: "2000000", buffer_bps: 150, usdc_amount: "2100000", max_amount: "2100000", salt: "7",
    min_fee_bps: 0, max_fee_bps: 0, fee_receiver: "0x0000000000000000000000000000000000000000",
    receiving_chain: "Ethereum_Sepolia", mode: "escrow", wedge: "digital_goods", state: "created",
    timeout_kind: "auto_capture", timeout_deadline: iso,
    pre_approval_expiry: iso, authorization_expiry: iso, refund_expiry: iso,
    payment_info_hash: "0xhash", eurc_out: null, rebate: null, failure_reason: null, funded_at: null, settled_at: null,
    ...o,
  };
}

/** Stateful in-memory store: get() after transition() reflects the new state. */
function memStore(initial: OrderRecord) {
  let rec = { ...initial };
  return {
    get: vi.fn(async () => ({ ...rec })),
    create: vi.fn(async (p: { id: string; usdcAmountMinor: bigint; priceEURMinor: bigint; bufferBps: number; receivingChain: string; wedge: OrderRecord["wedge"]; mode: OrderRecord["mode"] }) => {
      rec = mkOrder({
        id: p.id, state: "created", usdc_amount: p.usdcAmountMinor.toString(), max_amount: p.usdcAmountMinor.toString(),
        price_eur: p.priceEURMinor.toString(), buffer_bps: p.bufferBps, receiving_chain: p.receivingChain, wedge: p.wedge, mode: p.mode,
      });
      return { ...rec };
    }),
    transition: vi.fn(async (_id: string, to: OrderRecord["state"], patch: { fundedAt?: Date; settledAt?: Date; eurcOutMinor?: bigint; rebateMinor?: bigint } = {}) => {
      rec = {
        ...rec, state: to,
        ...(patch.eurcOutMinor !== undefined ? { eurc_out: patch.eurcOutMinor.toString() } : {}),
        ...(patch.rebateMinor !== undefined ? { rebate: patch.rebateMinor.toString() } : {}),
        ...(patch.fundedAt ? { funded_at: patch.fundedAt.toISOString() } : {}),
        ...(patch.settledAt ? { settled_at: patch.settledAt.toISOString() } : {}),
      };
      return { ...rec };
    }),
    recordPaymentIdempotent: vi.fn(async () => ({})),
    listPending: vi.fn(), recordPayment: vi.fn(), recordEvent: vi.fn(), deleteOrder: vi.fn(),
  };
}

function makeDeps(over: { store?: ReturnType<typeof memStore>; fxSwap?: unknown; initial?: OrderRecord } = {}): RivoKitDeps {
  const store = over.store ?? memStore(over.initial ?? mkOrder());
  const emitter = createEmitter();
  const escrow = {
    capture: vi.fn(async () => ({ txHash: "0xcap" })),
    void: vi.fn(async () => ({ txHash: "0xvoid" })),
    refund: vi.fn(async () => ({ txHash: "0xref" })),
    getTokenStore: vi.fn(async () => ADDR.operator),
  };
  const fx = {
    lockQuote: vi.fn(async () => ({ amountInMinor: 2_100_000n, quote: {} })),
    quote: vi.fn(async () => ({ amountInMinor: 1n, amountOutMinor: 1n, stopLimitMinor: null, fees: [] })),
    swapWithFloor:
      over.fxSwap ?? vi.fn(async () => ({ amountOutMinor: 2_030_000n, txHash: "0xswap", rebateMinor: 30_000n })),
  };
  const bridge = { execute: vi.fn(async () => ({ state: "success", steps: [], burnTxHash: "0xburn", mintTxHash: "0xmint", raw: {} })) };
  const fund = vi.fn(async () => ({ authorizeTxHash: "0xauth" }));

  return {
    store: store as unknown as RivoKitDeps["store"],
    escrow: escrow as unknown as RivoKitDeps["escrow"],
    fx: fx as unknown as RivoKitDeps["fx"],
    bridge: bridge as unknown as RivoKitDeps["bridge"],
    fund,
    emitter,
    config: {
      chainId: 5042002, escrowAddress: ADDR.escrow, operator: ADDR.operator, token: ADDR.token,
      refundCollector: ADDR.refundCollector, settlementAddress: ADDR.receiver,
    },
    now: () => NOW,
    salt: () => 7n,
    refundBridgeParams: () => ({
      fromAdapter: {}, fromChain: "Arc_Testnet", toAdapter: {}, toChain: "Ethereum_Sepolia",
      amountMinor: 2_100_000n, kitKey: "k",
    }) as never,
  } as unknown as RivoKitDeps;
}

const proof = { kind: "access_granted" as const };

describe("createOrder", () => {
  it("locks a quote, stores the order, returns usdcAmount", async () => {
    const deps = makeDeps();
    const kit = createRivoKit(deps);
    const order = await kit.createOrder({
      payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 2_000_000n,
      receivingChain: "Ethereum_Sepolia", wedge: "digital_goods",
    });
    expect(order.usdcAmount).toBe("2100000");
    expect(order.state).toBe("created");
    expect(deps.fx.lockQuote).toHaveBeenCalledOnce();
  });

  it("screens payer and receiver before storing, and a block stops the order", async () => {
    const deps = makeDeps();
    const assertAllowed = vi.fn(async () => {
      throw Object.assign(new Error("blocked"), { code: "COMPLIANCE_BLOCKED" });
    });
    (deps as RivoKitDeps).compliance = { assertAllowed, screen: vi.fn() } as never;
    const kit = createRivoKit(deps);
    await expect(
      kit.createOrder({ payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 2_000_000n, receivingChain: "Ethereum_Sepolia", wedge: "digital_goods" }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    expect(deps.store.create).not.toHaveBeenCalled();
  });
});

describe("fund", () => {
  it("transitions created→funding_pending→funded and emits both, via the injected executor", async () => {
    const deps = makeDeps({ initial: mkOrder({ state: "created" }) });
    const kit = createRivoKit(deps);
    const events: string[] = [];
    kit.on("funding_pending", () => events.push("funding_pending"));
    kit.on("funded", () => events.push("funded"));

    await kit.fund("ord_x");

    expect(deps.fund).toHaveBeenCalledOnce();
    expect(deps.store.recordPaymentIdempotent).toHaveBeenCalledWith(expect.objectContaining({ kind: "authorize", txHash: "0xauth" }));
    expect(events).toEqual(["funding_pending", "funded"]);
    expect((await kit.status("ord_x")).state).toBe("funded");
  });
});

describe("release", () => {
  it("captures, swaps, emits released, and produces a MOCK payout", async () => {
    const deps = makeDeps({ initial: mkOrder({ state: "funded" }) });
    const kit = createRivoKit(deps);
    const released: unknown[] = [];
    kit.on("released", (p) => released.push(p));

    await kit.release("ord_x", proof);

    expect(deps.escrow.capture).toHaveBeenCalledOnce();
    expect(released).toEqual([{ orderId: "ord_x", eurcOutMinor: 2_030_000n, rebateMinor: 30_000n }]);
    const payout = kit.payoutFor("ord_x");
    expect(payout).toMatchObject({ label: "MOCK", executed: false, target: { amountMinor: 2_030_000n } });
    expect((await kit.status("ord_x")).state).toBe("released");
  });

  it("lands in settlement_pending (not released) when the floor is missed", async () => {
    const deps = makeDeps({
      initial: mkOrder({ state: "funded" }),
      fxSwap: vi.fn(async () => {
        throw new FloorNotMetError(2_000_000n, new Error("stopLimit"));
      }),
    });
    const kit = createRivoKit(deps);
    const released = vi.fn();
    kit.on("released", released);

    await kit.release("ord_x", proof);

    expect(deps.escrow.capture).toHaveBeenCalledOnce();
    expect(released).not.toHaveBeenCalled();
    expect(kit.payoutFor("ord_x")).toBeUndefined();
    expect((await kit.status("ord_x")).state).toBe("settlement_pending");
  });
});

describe("refund", () => {
  it("voids a funded order and bridges back, reaching refunded", async () => {
    const deps = makeDeps({ initial: mkOrder({ state: "funded" }) });
    const kit = createRivoKit(deps);
    const events: Array<[string, unknown]> = [];
    kit.on("refund_pending", (p) => events.push(["refund_pending", p]));
    kit.on("refunded", (p) => events.push(["refunded", p]));

    await kit.refund("ord_x");

    expect(deps.escrow.void).toHaveBeenCalledOnce();
    expect(deps.escrow.refund).not.toHaveBeenCalled();
    expect(deps.bridge.execute).toHaveBeenCalledOnce();
    expect(events.map(([n]) => n)).toEqual(["refund_pending", "refunded"]);
    expect(events[1]?.[1]).toMatchObject({ chain: "Ethereum_Sepolia" });
    expect((await kit.status("ord_x")).state).toBe("refunded");
  });

  it("uses refund (not void) once captured, and stays refund_pending if the bridge is stuck", async () => {
    const deps = makeDeps({ initial: mkOrder({ state: "released" }) });
    deps.bridge.execute = vi.fn(async () => {
      throw new BridgeStuckError("in flight");
    });
    const kit = createRivoKit(deps);
    const refunded = vi.fn();
    kit.on("refunded", refunded);

    await kit.refund("ord_x");

    expect(deps.escrow.refund).toHaveBeenCalledOnce();
    expect(deps.escrow.void).not.toHaveBeenCalled();
    expect(refunded).not.toHaveBeenCalled();
    expect((await kit.status("ord_x")).state).toBe("refund_pending");
  });
});

describe("status / on", () => {
  it("returns a wire Order with string money", async () => {
    const kit = createRivoKit(makeDeps({ initial: mkOrder({ state: "funded" }) }));
    const o = await kit.status("ord_x");
    expect(typeof o.priceEUR).toBe("string");
    expect(o.receivingChain).toBe("Ethereum_Sepolia");
  });
});
