import { describe, expect, it } from "vitest";
import {
  ORDER_STATES,
  assertTransition,
  canTransition,
  isCaptured,
  isFunded,
  isTerminal,
  nextStates,
  type OrderState,
} from "./state-machine.ts";

/** Every edge the machine is supposed to allow. */
const ALLOWED: ReadonlyArray<[OrderState, OrderState]> = [
  ["created", "funding_pending"],
  ["created", "failed"],
  ["funding_pending", "funded"],
  ["funding_pending", "failed"],
  ["funded", "shipped"],
  ["funded", "released"],
  ["funded", "settlement_pending"],
  ["funded", "refund_pending"],
  ["funded", "failed"],
  ["settlement_pending", "released"],
  ["settlement_pending", "refund_pending"],
  ["settlement_pending", "failed"],
  ["shipped", "released"],
  ["shipped", "settlement_pending"],
  ["shipped", "refund_pending"],
  ["shipped", "failed"],
  ["released", "refund_pending"],
  ["refund_pending", "refunded"],
  ["refund_pending", "failed"],
  ["failed", "refund_pending"],
  ["failed", "funded"],
];

describe("allowed transitions", () => {
  it.each(ALLOWED)("%s → %s diterima", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });
});

describe("rejected transitions", () => {
  // Exhaustive: every pair NOT in ALLOWED must be refused. This catches an
  // edge accidentally widened far better than a handful of negative cases.
  const allowedKeys = new Set(ALLOWED.map(([f, t]) => `${f}→${t}`));
  const forbidden = ORDER_STATES.flatMap((from) =>
    ORDER_STATES.filter((to) => !allowedKeys.has(`${from}→${to}`)).map(
      (to) => [from, to] as const,
    ),
  );

  it.each(forbidden)("%s → %s is rejected", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(/Invalid transition/);
  });

  it("melaporkan kode INVALID_STATE sesuai API.md", () => {
    try {
      assertTransition("created", "released");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: string }).code).toBe("INVALID_STATE");
    }
  });
});

describe("sifat struktural", () => {
  it("no state transitions to itself", () => {
    for (const s of ORDER_STATES) expect(canTransition(s, s)).toBe(false);
  });

  it("refunded is the only terminal state", () => {
    expect(ORDER_STATES.filter(isTerminal)).toEqual(["refunded"]);
  });

  it("every state can reach refunded (funds are never stranded)", () => {
    // Breadth-first from each state; a state with no path to `refunded` would
    // mean funds that can never be returned to the payer.
    for (const start of ORDER_STATES) {
      const seen = new Set<OrderState>([start]);
      const queue: OrderState[] = [start];
      let reached = start === "refunded";
      while (queue.length && !reached) {
        const current = queue.shift()!;
        for (const next of nextStates(current)) {
          if (next === "refunded") reached = true;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(reached, `${start} has no path to refunded`).toBe(true);
    }
  });

  it("released can only go to refund_pending", () => {
    expect(nextStates("released")).toEqual(["refund_pending"]);
  });
});

describe("isFunded menjaga invariant 3 PRD §10", () => {
  it("funding_pending is NOT funded — attestation can still fail", () => {
    expect(isFunded("funding_pending")).toBe(false);
  });

  it.each(["funded", "settlement_pending", "shipped", "released"] as const)(
    "%s dianggap funded",
    (s) => {
      expect(isFunded(s)).toBe(true);
    },
  );
});

describe("isCaptured — funds have left escrow", () => {
  it.each(["settlement_pending", "released"] as const)("%s is captured", (s) => {
    expect(isCaptured(s)).toBe(true);
  });

  it.each(["created", "funding_pending", "funded", "shipped"] as const)(
    "%s is NOT captured yet — void is still cheap",
    (s) => {
      expect(isCaptured(s)).toBe(false);
    },
  );

  it("settlement_pending cannot go back to funded", () => {
    // Escrow is already empty; pretending otherwise would invite a void that
    // has nothing to void.
    expect(canTransition("settlement_pending", "funded")).toBe(false);
  });

  it.each(["created", "refund_pending", "refunded", "failed"] as const)(
    "%s BUKAN funded",
    (s) => {
      expect(isFunded(s)).toBe(false);
    },
  );
});
