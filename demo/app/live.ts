"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll a GET endpoint, starting from data the server already rendered.
 *
 * WHAT IT IS FOR
 *
 * Every panel in this demo used to do the same three things by hand: fetch on
 * mount through a Server Action, set an interval, and hold `null` until the
 * first answer came back. That produced the two complaints this replaces — a
 * page that shows nothing for several seconds after it loads, and a queue of
 * POSTs that a click has to wait behind.
 *
 * `initial` comes from the Server Component that rendered the page, so the
 * first paint already has the data and the first poll is a REFRESH rather than
 * the only way to see anything.
 *
 * THE RULES IT KEEPS
 *
 *  - never two requests in flight at once. A slow answer must not stack up
 *    behind an interval that keeps firing.
 *  - a failed poll leaves the last good value on screen. Blanking the panel
 *    because one read timed out loses information the user still has.
 *  - polling stops while the tab is hidden, and refreshes on return. A
 *    background tab burning the Arc RPC's quota is how the foreground one ends
 *    up unable to read a balance.
 */
export function useLive<T>(
  url: string | null,
  initial: T | null,
  /**
   * `null` means "do not poll, but stay refreshable".
   *
   * The distinction matters: the board stops polling once no order can still
   * change, and it must still be able to re-read the instant a button moves
   * money. Disabling the poll by passing `url: null` would have taken `refresh`
   * away with it.
   */
  intervalMs: number | null,
): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: it guards the fetch itself and must never cause a render.
  const inFlight = useRef(false);

  const read = useCallback(async () => {
    if (!url || inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!res.ok || body.ok === false) {
        setError(body.error ?? `request failed (${res.status})`);
        return;
      }
      setData(body);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).slice(0, 200));
    } finally {
      inFlight.current = false;
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    // No fetch on mount when the server already supplied the data: that first
    // request is the one the page does not need, and it competes with whatever
    // the user does in the first second.
    if (initial == null) void read();
    if (intervalMs == null) return;

    const tick = () => { if (document.visibilityState === "visible") void read(); };
    const id = setInterval(tick, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `initial` deliberately absent: it is the seed, and re-seeding on a new
    // object identity would re-run the mount branch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs, read]);

  return { data, error, refresh: () => void read() };
}

/** One-off GET for the same endpoints, for callers that are not polling. */
export async function getJson<T>(url: string): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok && body?.ok !== false) return { ok: false, error: `request failed (${res.status})` };
    return body;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
