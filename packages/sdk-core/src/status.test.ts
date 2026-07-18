import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES, canTransition, isTerminal } from "./status.js";

describe("state machine", () => {
  it("punya tepat 8 status Tier-1", () => {
    expect(PAYMENT_STATUSES).toHaveLength(8);
  });

  it("dari settled hanya boleh ke reversed", () => {
    expect(canTransition("settled", "reversed")).toBe(true);
    expect(canTransition("settled", "failed")).toBe(false);
    expect(canTransition("settled", "processing")).toBe(false);
  });

  it("failed dan reversed terminal", () => {
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("reversed")).toBe(true);
    expect(canTransition("failed", "processing")).toBe(false);
  });

  it("held hanya menuju processing atau reversed", () => {
    expect(canTransition("held", "processing")).toBe(true);
    expect(canTransition("held", "reversed")).toBe(true);
    expect(canTransition("held", "settled")).toBe(false);
  });
});
