/**
 * The bank path: `release()` capturing and then driving an off-ramp.
 *
 * What these tests are really guarding is the boundary between "checked" and
 * "irreversible". A submitted payout cannot be recalled, so every reason to
 * refuse one has to fire BEFORE `submit` is reached — and the way to prove that
 * is not to assert on a returned status but to assert that the rail's `submit`
 * was never called at all. Most of the cases below do exactly that.
 */
import { describe, expect, it, vi } from "vitest";
import { createRivoKit, PayoutUnavailableError, type RivoKitDeps } from "./rivokit.ts";
import { createEmitter } from "../events/emitter.ts";
import type { OrderRecord } from "../orchestrator/order-store.ts";
import type { PayoutInstruction } from "../payout/instruction.ts";
import type { PayoutQuote, PayoutRail } from "../payout/rail.ts";

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
    id: "ord_bank", payer: ADDR.payer, receiver: ADDR.receiver, operator: ADDR.operator, token: ADDR.token,
    // 12.60 USDC authorized against a 12.00 EUR floor: comfortably over the
    // corridor minimum, with a real surplus for the rebate to find.
    price_eur: "12000000", buffer_bps: 150, usdc_amount: "12600000", max_amount: "12600000", salt: "7",
    min_fee_bps: 0, max_fee_bps: 0, fee_receiver: "0x0000000000000000000000000000000000000000",
    receiving_chain: "Arc_Testnet", mode: "escrow", payout_to: "bank", wedge: "digital_goods",
    state: "funded", timeout_kind: "auto_capture", timeout_deadline: iso,
    pre_approval_expiry: iso, authorization_expiry: iso, refund_expiry: iso,
    payment_info_hash: "0xhash", eurc_out: null, rebate: null, failure_reason: null,
    created_at: "2026-07-30T00:00:00Z", funded_at: "2026-07-30T00:01:00Z", settled_at: null,
    ...o,
  };
}

function memStore(initial: OrderRecord) {
  let rec = { ...initial };
  let payout: PayoutInstruction | null = null;
  return {
    get: vi.fn(async () => ({ ...rec })),
    create: vi.fn(async (p: { id: string; payoutTo?: "wallet" | "bank"; usdcAmountMinor: bigint; priceEURMinor: bigint }) => {
      rec = mkOrder({
        id: p.id, state: "created", payout_to: p.payoutTo ?? "wallet",
        usdc_amount: p.usdcAmountMinor.toString(), max_amount: p.usdcAmountMinor.toString(),
        price_eur: p.priceEURMinor.toString(),
      });
      return { ...rec };
    }),
    transition: vi.fn(async (_id: string, to: OrderRecord["state"], patch: { settledAt?: Date; failureReason?: string } = {}) => {
      rec = {
        ...rec, state: to,
        ...(patch.failureReason !== undefined ? { failure_reason: patch.failureReason } : {}),
        ...(patch.settledAt ? { settled_at: patch.settledAt.toISOString() } : {}),
      };
      return { ...rec };
    }),
    recordPaymentIdempotent: vi.fn(async () => ({})),
    // Mirrors the real store's guard rather than accepting anything: a fake
    // that allows a confirmed row with no hash would let a test pass that the
    // database would reject.
    advancePayment: vi.fn(async (nonce: string, patch: { status: string; txHash?: string }) => {
      if (patch.status === "confirmed" && !patch.txHash) {
        throw new Error(`advancePayment(${nonce}): a confirmed payment needs a txHash`);
      }
      return null;
    }),
    savePayout: vi.fn(async (_id: string, p: PayoutInstruction) => { payout = p; }),
    getPayout: vi.fn(async () => payout),
    listPending: vi.fn(), recordPayment: vi.fn(), recordEvent: vi.fn(), deleteOrder: vi.fn(),
  };
}

/** A rail that behaves; individual tests bend one part of it. */
function mkRail(over: Partial<PayoutRail> & { requiredSourceMinor?: bigint; destinationMinor?: bigint; expiresAt?: number } = {}): PayoutRail {
  const requiredSourceMinor = over.requiredSourceMinor ?? 12_400_000n;
  const destinationMinor = over.destinationMinor ?? 1200n;
  return {
    id: "cpn",
    corridor: "EUR-SEPA",
    limits: vi.fn(async () => ({
      minSourceMinor: 11_000_000n, maxSourceMinor: 5_000_000_000_000n,
      sourceCurrency: "USDC", destinationCurrency: "EUR", destinationScale: 2,
    })),
    ready: vi.fn(async () => {}),
    quote: vi.fn(async (): Promise<PayoutQuote> => ({
      requiredSourceMinor, destinationMinor, destinationCurrency: "EUR", destinationScale: 2,
      sourceCurrency: "USDC", expiresAt: over.expiresAt ?? NOW + 45, intent: { fake: true },
    })),
    // No txHash: a real broadcast returns before the transfer is mined, so the
    // hash genuinely does not exist yet. Faking one here would hide the whole
    // reason the ledger row starts out `pending`.
    submit: vi.fn(async (q: PayoutQuote) => ({
      paymentId: "pay_abc", status: "CRYPTO_FUNDS_PENDING",
      requiredSourceMinor: q.requiredSourceMinor, destinationMinor: q.destinationMinor,
      destinationCurrency: "EUR", destinationScale: 2,
    })),
    ...over,
  } as PayoutRail;
}

function makeDeps(over: {
  store?: ReturnType<typeof memStore>;
  rail?: PayoutRail | undefined;
  initial?: OrderRecord;
  payRebate?: unknown;
  hasRail?: boolean;
} = {}): RivoKitDeps & { store: ReturnType<typeof memStore> } {
  const store = over.store ?? memStore(over.initial ?? mkOrder());
  const escrow = {
    capture: vi.fn(async () => ({ txHash: "0xcap" })),
    void: vi.fn(async () => ({ txHash: "0xvoid" })),
    refund: vi.fn(async () => ({ txHash: "0xref" })),
    getTokenStore: vi.fn(async () => ADDR.operator),
  };
  const fx = {
    lockQuote: vi.fn(async () => ({ amountInMinor: 12_600_000n, quote: {} })),
    quote: vi.fn(async () => ({ amountInMinor: 1n, amountOutMinor: 1n, stopLimitMinor: null, fees: [] })),
    swapWithFloor: vi.fn(async () => ({ amountOutMinor: 0n, txHash: "0xswap", rebateMinor: 0n })),
  };
  const rail = over.hasRail === false ? undefined : (over.rail ?? mkRail());

  return {
    store: store as unknown as RivoKitDeps["store"],
    escrow: escrow as unknown as RivoKitDeps["escrow"],
    fx: fx as unknown as RivoKitDeps["fx"],
    bridge: { execute: vi.fn() } as unknown as RivoKitDeps["bridge"],
    fund: vi.fn(async () => ({ authorizeTxHash: "0xauth" })),
    ...(rail ? { payoutRail: rail } : {}),
    ...(over.payRebate !== undefined ? { payRebate: over.payRebate as RivoKitDeps["payRebate"] } : {}),
    emitter: createEmitter(),
    config: {
      chainId: 5042002, escrowAddress: ADDR.escrow, operator: ADDR.operator, token: ADDR.token,
      refundCollector: ADDR.refundCollector, settlementAddress: ADDR.receiver,
    },
    now: () => NOW,
    salt: () => 7n,
  } as unknown as RivoKitDeps & { store: ReturnType<typeof memStore> };
}

const proof = { kind: "access_granted" as const };

describe("createOrder — refusing a bank order while refusing is free", () => {
  it('rejects payoutTo: "bank" when no rail is wired', async () => {
    const kit = createRivoKit(makeDeps({ hasRail: false }));
    await expect(
      kit.createOrder({
        payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 12_000_000n,
        receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank",
      }),
    ).rejects.toThrow(PayoutUnavailableError);
  });

  // The corridor minimum is live data that drifts with FX, so the check has to
  // ask the rail. Failing here means nothing has moved; failing at release
  // would mean an escrow already captured for a payout that cannot happen.
  it("rejects an order below the corridor minimum, before anything is stored", async () => {
    const deps = makeDeps();
    (deps.fx.lockQuote as ReturnType<typeof vi.fn>).mockResolvedValue({ amountInMinor: 5_000_000n, quote: {} });
    const kit = createRivoKit(deps);
    await expect(
      kit.createOrder({
        payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 4_000_000n,
        receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank",
      }),
    ).rejects.toThrow(/at least 11000000/);
    expect(deps.store.create).not.toHaveBeenCalled();
  });

  it("rejects an order above the corridor ceiling", async () => {
    const deps = makeDeps();
    (deps.fx.lockQuote as ReturnType<typeof vi.fn>).mockResolvedValue({ amountInMinor: 9_000_000_000_000n, quote: {} });
    const kit = createRivoKit(deps);
    await expect(
      kit.createOrder({
        payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 8_000_000_000_000n,
        receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank",
      }),
    ).rejects.toThrow(/ceiling/);
  });

  // Sizing a bank order from StableFX prices the buffer against a spread the
  // order will never pay. The rail that WILL pay it is the one to ask.
  it("sizes a bank order from the rail, not from StableFX", async () => {
    const rail = mkRail({ estimate: vi.fn(async () => ({ requiredSourceMinor: 11_600_000n })) });
    const deps = makeDeps({ rail });
    const order = await createRivoKit(deps).createOrder({
      payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 12_000_000n,
      receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank", bufferBps: 150,
    });

    expect(rail.estimate).toHaveBeenCalledWith(1200n);
    expect(deps.fx.lockQuote).not.toHaveBeenCalled();
    // 11.60 USDC + 1.5% buffer = 11.774.
    expect(order.usdcAmount).toBe("11774000");
  });

  it("falls back to StableFX when the rail cannot estimate", async () => {
    const deps = makeDeps();
    await createRivoKit(deps).createOrder({
      payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 12_000_000n,
      receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank",
    });
    expect(deps.fx.lockQuote).toHaveBeenCalledOnce();
  });

  it("still checks the corridor when sizing from the rail", async () => {
    const rail = mkRail({ estimate: vi.fn(async () => ({ requiredSourceMinor: 5_000_000n })) });
    await expect(
      createRivoKit(makeDeps({ rail })).createOrder({
        payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 4_000_000n,
        receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank",
      }),
    ).rejects.toThrow(/at least 11000000/);
  });

  it("leaves wallet orders alone — no rail is consulted", async () => {
    const deps = makeDeps({ hasRail: false });
    const kit = createRivoKit(deps);
    const order = await kit.createOrder({
      payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 12_000_000n,
      receivingChain: "Arc_Testnet", wedge: "digital_goods",
    });
    expect(order.payoutTo).toBe("wallet");
  });

  it("checks the NET, not the gross — the operator fee never reaches the rail", async () => {
    const deps = makeDeps();
    // 11.1 USDC net grosses up past the minimum, but the rail only ever sees
    // the net, so the net is what must clear it.
    (deps.fx.lockQuote as ReturnType<typeof vi.fn>).mockResolvedValue({ amountInMinor: 10_900_000n, quote: {} });
    const kit = createRivoKit(deps);
    await expect(
      kit.createOrder({
        payer: ADDR.payer, receiver: ADDR.receiver, priceEURMinor: 10_000_000n,
        receivingChain: "Arc_Testnet", wedge: "digital_goods", payoutTo: "bank",
        feeBps: 25, feeReceiver: ADDR.operator,
      }),
    ).rejects.toThrow(/at least 11000000/);
  });
});

describe("release — the bank path", () => {
  it("captures, off-ramps, and lands in payout_pending", async () => {
    const deps = makeDeps();
    const rail = deps.payoutRail!;
    const kit = createRivoKit(deps);

    await kit.release("ord_bank", proof);

    expect(deps.escrow.capture).toHaveBeenCalledOnce();
    expect(rail.submit).toHaveBeenCalledOnce();
    // No swap on this path: converting to EURC first would pay a spread to
    // reach a currency that is immediately spent to reach another one.
    expect(deps.fx.swapWithFloor).not.toHaveBeenCalled();
    expect((await kit.status("ord_bank")).state).toBe("payout_pending");
  });

  it("quotes the DESTINATION side, converting the floor into the rail's scale", async () => {
    const deps = makeDeps();
    const kit = createRivoKit(deps);
    await kit.release("ord_bank", proof);

    // 12_000_000 micro-EURC → 1200 cents. Pinning the destination is what makes
    // the seller's floor the guaranteed quantity rather than an outcome.
    expect(deps.payoutRail!.quote).toHaveBeenCalledWith(
      expect.objectContaining({ destinationMinor: 1200n, availableSourceMinor: 12_600_000n }),
    );
  });

  it("runs ready() BEFORE quoting, so an allowance tx cannot eat the quote's life", async () => {
    const calls: string[] = [];
    const rail = mkRail({
      ready: vi.fn(async () => { calls.push("ready"); }),
      quote: vi.fn(async (): Promise<PayoutQuote> => {
        calls.push("quote");
        return {
          requiredSourceMinor: 12_400_000n, destinationMinor: 1200n, destinationCurrency: "EUR",
          destinationScale: 2, sourceCurrency: "USDC", expiresAt: NOW + 45, intent: {},
        };
      }),
    });

    await createRivoKit(makeDeps({ rail })).release("ord_bank", proof);
    expect(calls).toEqual(["ready", "quote"]);
  });

  it("writes a LIVE payout carrying the payment id", async () => {
    const deps = makeDeps();
    const kit = createRivoKit(deps);
    await kit.release("ord_bank", proof);

    const payout = await kit.payoutFor("ord_bank");
    expect(payout).toMatchObject({
      kind: "cpn", label: "LIVE", executed: true,
      target: { currency: "EUR", amountMinor: 1200n, scale: 2, estimated: false },
      reference: { rail: "cpn", corridor: "EUR-SEPA", paymentId: "pay_abc", status: "CRYPTO_FUNDS_PENDING" },
    });
  });

  it("persists the payout BEFORE the transition", async () => {
    // Not cosmetic ordering: `offramp_states_have_live_payout` refuses
    // payout_pending on an order with no live payout, so a transition that ran
    // first would be rejected by the database.
    const deps = makeDeps();
    const seen: string[] = [];
    deps.store.savePayout.mockImplementation(async () => { seen.push("savePayout"); });
    deps.store.transition.mockImplementation(async (_id, to) => { seen.push(`transition:${to}`); return mkOrder({ state: to }); });

    await createRivoKit(deps).release("ord_bank", proof);
    expect(seen).toEqual(["savePayout", "transition:payout_pending"]);
  });

  it("returns the surplus to the payer as USDC, not EURC", async () => {
    const payRebate = vi.fn(async () => ({ txHash: "0xrebate" }));
    const deps = makeDeps({ payRebate });
    await createRivoKit(deps).release("ord_bank", proof);

    // 12.60 captured − 12.40 the quote needed = 0.20 USDC of buffer the payer
    // overpaid. No swap ran, so this surplus is USDC; sending EURC would be
    // sending an asset the settlement wallet does not hold from this order.
    expect(payRebate).toHaveBeenCalledWith({
      orderId: "ord_bank", to: ADDR.payer, amountMinor: 200_000n, token: "USDC",
    });
  });

  it("pays the rebate AFTER broadcasting — the quote clock outranks the tidying", async () => {
    const seen: string[] = [];
    const payRebate = vi.fn(async () => { seen.push("rebate"); return { txHash: "0xrebate" }; });
    const deps = makeDeps({ payRebate });
    (deps.payoutRail!.submit as ReturnType<typeof vi.fn>).mockImplementation(async (q: PayoutQuote) => {
      seen.push("submit");
      return {
        paymentId: "pay_abc", status: "CRYPTO_FUNDS_PENDING",
        requiredSourceMinor: q.requiredSourceMinor, destinationMinor: q.destinationMinor,
        destinationCurrency: "EUR", destinationScale: 2,
      };
    });

    await createRivoKit(deps).release("ord_bank", proof);
    expect(seen).toEqual(["submit", "rebate"]);
  });

  it("emits payout_pending with what was broadcast", async () => {
    const deps = makeDeps();
    const kit = createRivoKit(deps);
    const events: unknown[] = [];
    kit.on("payout_pending", (e) => events.push(e));

    await kit.release("ord_bank", proof);
    expect(events[0]).toMatchObject({
      orderId: "ord_bank", paymentId: "pay_abc", rail: "cpn", corridor: "EUR-SEPA",
      sourceMinor: 12_400_000n, destinationMinor: 1200n, destinationCurrency: "EUR",
    });
  });
});

describe("release — every refusal happens before the irreversible step", () => {
  /** Assert the order stalled safely and nothing was broadcast. */
  async function expectStalled(deps: ReturnType<typeof makeDeps>, reason: RegExp) {
    const kit = createRivoKit(deps);
    await kit.release("ord_bank", proof);

    expect(deps.payoutRail!.submit).not.toHaveBeenCalled();
    const order = await kit.status("ord_bank");
    expect(order.state).toBe("settlement_pending");
    expect(deps.store.transition).toHaveBeenCalledWith(
      "ord_bank", "settlement_pending", expect.objectContaining({ failureReason: expect.stringMatching(reason) }),
    );
    // The capture still happened — that is exactly what settlement_pending
    // means, and pretending the funds are still in escrow would be the lie
    // this state exists to avoid.
    expect(deps.escrow.capture).toHaveBeenCalledOnce();
  }

  it("stalls when the quote delivers less than the floor", async () => {
    const deps = makeDeps({ rail: mkRail({ destinationMinor: 1199n }) });
    await expectStalled(deps, /below the floor/);
  });

  it("stalls when the floor costs more than was captured", async () => {
    const deps = makeDeps({ rail: mkRail({ requiredSourceMinor: 12_700_000n }) });
    await expectStalled(deps, /only 12600000 was captured/);
  });

  it("stalls when the quote already expired", async () => {
    const deps = makeDeps({ rail: mkRail({ expiresAt: NOW - 1 }) });
    await expectStalled(deps, /expired/);
  });

  it("stalls when the rail cannot quote at all", async () => {
    const rail = mkRail();
    (rail.quote as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("PM09000 quote expired"));
    await expectStalled(makeDeps({ rail }), /Payout quote failed/);
  });

  it("stalls when the capture nets less than the corridor takes", async () => {
    const rail = mkRail();
    (rail.limits as ReturnType<typeof vi.fn>).mockResolvedValue({
      minSourceMinor: 13_000_000n, maxSourceMinor: 5_000_000_000_000n,
      sourceCurrency: "USDC", destinationCurrency: "EUR", destinationScale: 2,
    });
    const deps = makeDeps({ rail });
    await expectStalled(deps, /below the EUR-SEPA minimum/);
    expect(rail.quote).not.toHaveBeenCalled();
  });

  it("refuses to capture at all when the rail vanished after the order was created", async () => {
    const deps = makeDeps({ hasRail: false });
    const kit = createRivoKit(deps);
    await expect(kit.release("ord_bank", proof)).rejects.toThrow(PayoutUnavailableError);
    expect(deps.escrow.capture).not.toHaveBeenCalled();
  });

  it("refuses a proof the wedge does not accept, before capturing", async () => {
    const deps = makeDeps({ initial: mkOrder({ wedge: "physical_demo" }) });
    const kit = createRivoKit(deps);
    await expect(kit.release("ord_bank", { kind: "access_granted" })).rejects.toThrow();
    expect(deps.escrow.capture).not.toHaveBeenCalled();
    expect(deps.payoutRail!.submit).not.toHaveBeenCalled();
  });

  it("refuses an illegal lifecycle jump, before capturing", async () => {
    const deps = makeDeps({ initial: mkOrder({ state: "created" }) });
    const kit = createRivoKit(deps);
    await expect(kit.release("ord_bank", proof)).rejects.toThrow(/Invalid transition/);
    expect(deps.escrow.capture).not.toHaveBeenCalled();
  });
});

describe("refreshPayout — following an async fiat leg", () => {
  async function broadcast(over: Parameters<typeof makeDeps>[0] = {}) {
    const deps = makeDeps(over);
    const kit = createRivoKit(deps);
    await kit.release("ord_bank", proof);
    return { deps, kit };
  }

  it("advances to paid_out when the rail reports delivery", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "COMPLETED", terminal: true, delivered: true, txHash: "0xmined" }));
    const { deps, kit } = await broadcast({ rail });

    const events: unknown[] = [];
    kit.on("paid_out", (e) => events.push(e));
    await kit.refreshPayout("ord_bank");

    expect((await kit.status("ord_bank")).state).toBe("paid_out");
    expect(events[0]).toMatchObject({ orderId: "ord_bank", paymentId: "pay_abc", destinationMinor: 1200n, destinationCurrency: "EUR" });
    expect(deps.store.transition).toHaveBeenCalledWith("ord_bank", "paid_out", expect.objectContaining({ settledAt: expect.any(Date) }));
  });

  // A payment in flight is not progress. The stored status is updated so a UI
  // can show it, but the order stays where it is — inventing a terminal state
  // from a non-terminal report is the one thing this method must not do.
  // The ledger row is written `pending` at submit time, because that is the
  // truth then — the transfer has not been mined and has no hash. Leaving it
  // there once the payout is terminal would make the ledger disagree with the
  // order it describes.
  it("settles the ledger row with the mined hash", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "COMPLETED", terminal: true, delivered: true, txHash: "0xmined" }));
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    expect(deps.store.advancePayment).toHaveBeenCalledWith(
      expect.stringMatching(/:payout$/),
      { status: "confirmed", txHash: "0xmined" },
    );
    // And the hash reaches the payout record, where a reader looks for it.
    expect((await kit.payoutFor("ord_bank"))?.reference?.txHash).toBe("0xmined");
  });

  // `confirmed_has_tx` rejects a confirmed row with no hash, on the principle
  // that an unverifiable confirmation is worth less than an honest pending.
  it("leaves the row pending when delivery is reported without a hash", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "COMPLETED", terminal: true, delivered: true }));
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    expect(deps.store.advancePayment).not.toHaveBeenCalled();
    // The ORDER still advances: the fiat did land, and withholding that
    // because a hash was missing would be the bigger lie.
    expect((await kit.status("ord_bank")).state).toBe("paid_out");
  });

  it("marks the ledger row failed, with the rail's reason", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({
      status: "FAILED", terminal: true, delivered: false, failureReason: "beneficiary rejected",
    }));
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    expect(deps.store.advancePayment).toHaveBeenCalledWith(
      expect.stringMatching(/:payout$/),
      { status: "failed", errorReason: "beneficiary rejected" },
    );
  });

  it("does not touch the ledger row while the payout is still in flight", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "FIAT_PAYMENT_INITIATED", terminal: false, delivered: false }));
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    expect(deps.store.advancePayment).not.toHaveBeenCalled();
  });

  it("keeps a hash it already holds when a later read omits it", async () => {
    const rail = mkRail();
    let call = 0;
    rail.status = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { status: "FIAT_PAYMENT_INITIATED", terminal: false, delivered: false, txHash: "0xmined" }
        : { status: "COMPLETED", terminal: true, delivered: true };
    });
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    await kit.refreshPayout("ord_bank");
    // A later read that omits the hash is silence, not news.
    expect(deps.store.advancePayment).toHaveBeenCalledWith(
      expect.stringMatching(/:payout$/),
      { status: "confirmed", txHash: "0xmined" },
    );
  });

  it("records an intermediate status without advancing the order", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "FIAT_PAYMENT_INITIATED", terminal: false, delivered: false }));
    const { kit } = await broadcast({ rail });

    const payout = await kit.refreshPayout("ord_bank");
    expect(payout?.reference?.status).toBe("FIAT_PAYMENT_INITIATED");
    expect((await kit.status("ord_bank")).state).toBe("payout_pending");
  });

  it("returns a FAILED payout to settlement_pending, not failed", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "FAILED", terminal: true, delivered: false, failureReason: "beneficiary rejected" }));
    const { kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    // CPN returns the USDC to the refund address, which is the settlement
    // wallet — so the order is captured-but-not-converted again, exactly what
    // settlement_pending has always meant. `failed` would read as "broken".
    expect((await kit.status("ord_bank")).state).toBe("settlement_pending");
  });

  // Without this, a run that ended before the hash existed leaves a `pending`
  // row on a finished order that nothing can ever repair.
  it("repairs a stale ledger row on an order already at paid_out", async () => {
    const rail = mkRail();
    let call = 0;
    rail.status = vi.fn(async () => {
      call += 1;
      // First read: delivered, hash not yet visible. Second: the hash appears.
      return call === 1
        ? { status: "COMPLETED", terminal: true, delivered: true }
        : { status: "COMPLETED", terminal: true, delivered: true, txHash: "0xlate" };
    });
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    expect((await kit.status("ord_bank")).state).toBe("paid_out");
    expect(deps.store.advancePayment).not.toHaveBeenCalled();

    deps.store.transition.mockClear();
    await kit.refreshPayout("ord_bank");

    expect(deps.store.advancePayment).toHaveBeenCalledWith(
      expect.stringMatching(/:payout$/),
      { status: "confirmed", txHash: "0xlate" },
    );
    // The order itself is left alone: paid_out → paid_out is not a legal move,
    // and re-emitting a terminal event would report the same thing twice.
    expect(deps.store.transition).not.toHaveBeenCalled();
  });

  it("stops asking once the status is settled and the hash is held", async () => {
    const rail = mkRail();
    rail.status = vi.fn(async () => ({ status: "COMPLETED", terminal: true, delivered: true, txHash: "0xmined" }));
    const { deps, kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    deps.store.savePayout.mockClear();
    await kit.refreshPayout("ord_bank");
    expect(deps.store.savePayout).not.toHaveBeenCalled();
  });

  it("does nothing for an order that never broadcast a payout", async () => {
    const deps = makeDeps({ initial: mkOrder({ state: "funded" }) });
    const kit = createRivoKit(deps);
    expect(await kit.refreshPayout("ord_bank")).toBeNull();
    expect(deps.store.transition).not.toHaveBeenCalled();
  });

  it("leaves the order alone when the rail cannot report status", async () => {
    const rail = mkRail();
    delete (rail as { status?: unknown }).status;
    const { kit } = await broadcast({ rail });

    await kit.refreshPayout("ord_bank");
    expect((await kit.status("ord_bank")).state).toBe("payout_pending");
  });
});
