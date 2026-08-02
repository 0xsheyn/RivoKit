"use client";

import { toast } from "sonner";

/**
 * One place where "something is happening" is said out loud.
 *
 * Several actions here take a minute or more — a CCTP bridge waits ~8s for an
 * attestation, a release captures then broadcasts to a payment network — and
 * the only feedback used to be a button greying out. That reads as a click that
 * did not register, so people click again.
 *
 * The toast lives for exactly as long as the work: it appears on the call and
 * is replaced by the outcome when the promise settles, never on a timer.
 */
export async function withToast<T>(
  label: string,
  work: () => Promise<T>,
  outcome?: (result: T) => { ok: boolean; message: string },
): Promise<T> {
  const id = toast.loading(label);
  try {
    const result = await work();
    const o = outcome?.(result);
    if (o && !o.ok) toast.error(o.message, { id });
    else toast.success(o?.message ?? `${label} — done`, { id });
    return result;
  } catch (e) {
    // Rethrow: the caller still owns error handling. The toast only reports.
    toast.error(`${label} failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, { id });
    throw e;
  }
}

/** The shape every marketplace server action returns. */
export type ActionOutcome = { ok: boolean; error?: string };

/** `withToast` for those, so a returned `{ok:false}` reads as a failure too. */
export const withActionToast = <T extends ActionOutcome>(label: string, work: () => Promise<T>) =>
  withToast(label, work, (r) => ({ ok: r.ok, message: r.ok ? `${label} — done` : r.error ?? `${label} failed` }));

export { toast };
