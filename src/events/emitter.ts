/**
 * Order lifecycle events — how a host keeps its UI in sync without polling
 * (PRD US-06). This is `rivokit.on(event, handler)` under the hood.
 *
 * The event names are the order states that a host cares about, one-to-one with
 * API.md's Events table. That correspondence is deliberate: a state transition
 * is the single source of these events, so `emitForState` derives the event from
 * the new state rather than letting call sites invent their own names and drift
 * from the state machine.
 *
 * The chain remains the source of truth for funds (CLAUDE.md §2, events row) —
 * these notifications report what already happened on-chain and in the store,
 * they never decide it.
 */
import type { OrderState } from "../orchestrator/state-machine.ts";

export type OrderEventMap = {
  funding_pending: { orderId: string };
  funded: { orderId: string };
  released: { orderId: string; eurcOutMinor: bigint; rebateMinor: bigint };
  refund_pending: { orderId: string };
  refunded: { orderId: string; chain: string };
  failed: { orderId: string; reason: string };
};

export type OrderEventName = keyof OrderEventMap;

/** States that carry no host-facing event (no `on(...)` name maps to them). */
const SILENT_STATES: ReadonlySet<OrderState> = new Set(["created", "settlement_pending", "shipped"]);

export type Handler<E extends OrderEventName> = (payload: OrderEventMap[E]) => void;

export function createEmitter() {
  // Stored loosely (the key already pins the payload type at the public
  // boundary); a per-event mapped type here fights generic variance for no gain.
  const handlers = new Map<OrderEventName, Set<(payload: never) => void>>();

  function on<E extends OrderEventName>(event: E, handler: Handler<E>): () => void {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => off(event, handler);
  }

  function off<E extends OrderEventName>(event: E, handler: Handler<E>): void {
    handlers.get(event)?.delete(handler as (payload: never) => void);
  }

  function emit<E extends OrderEventName>(event: E, payload: OrderEventMap[E]): void {
    const set = handlers.get(event);
    if (!set) return;
    // One throwing handler must not stop the others or the emitting flow — a
    // host callback failing is the host's problem, not a reason to derail an
    // order that already advanced on-chain.
    for (const handler of set) {
      try {
        (handler as (p: OrderEventMap[E]) => void)(payload);
      } catch (e) {
        console.warn(`[rivokit events] handler untuk "${event}" melempar dan diabaikan:`, e);
      }
    }
  }

  /**
   * Emit the event that corresponds to an order's new state. Returns the event
   * name emitted, or null for states with no host-facing event — so a caller
   * can tell "nothing to emit" from "emitted".
   */
  function emitForState(
    state: OrderState,
    payload: OrderEventMap[OrderEventName],
  ): OrderEventName | null {
    if (SILENT_STATES.has(state)) return null;
    const name = state as OrderEventName;
    emit(name, payload as never);
    return name;
  }

  return { on, off, emit, emitForState };
}

export type Emitter = ReturnType<typeof createEmitter>;
