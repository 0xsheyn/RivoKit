import type { Leg } from "@rivokit/core";
import { describe, expect, it } from "vitest";
import { decideRecovery } from "./executor.js";

function legOf(type: Leg["type"]): Leg {
  return {
    legId: "leg_1" as Leg["legId"],
    paymentId: "pay_1" as Leg["paymentId"],
    type,
    status: "failed",
    txHash: null,
    attempts: 1,
  };
}

describe("saga recovery", () => {
  it("kegagalan transien pada leg reversible = forward-retry", () => {
    expect(decideRecovery(legOf("fx"), "transient").action).toBe("forward-retry");
  });

  it("off-ramp TIDAK BOLEH forward-retry — dipaksa RECONCILE", () => {
    expect(decideRecovery(legOf("offramp"), "transient").action).toBe("reconcile");
  });

  it("kegagalan permanen = compensate", () => {
    expect(decideRecovery(legOf("bridge"), "permanent").action).toBe("compensate");
  });

  it("butuh input = action_required", () => {
    expect(decideRecovery(legOf("offramp"), "needs-input").action).toBe("action-required");
  });
});
