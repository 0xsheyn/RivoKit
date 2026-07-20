/**
 * Arc RPC transport.
 *
 * Arc's public endpoint rate-limits aggressively — it returns
 * `request limit reached` after only a couple of calls in quick succession.
 * That surfaces through viem as a bare "RPC Request failed", which reads like
 * an outage but is throttling. Any code path that makes more than one or two
 * reads WILL hit it.
 *
 * So: never point a client at a single URL. Use `arcTransport()`, which
 * rotates across all three published endpoints and retries with backoff.
 * Long live runs should also be written to resume, because a run can still be
 * cut off mid-flight.
 */
import { fallback, http, type Transport } from "viem";
import { ARC_TESTNET_RPC_FALLBACKS } from "../constants/arc.ts";

export type ArcTransportOptions = {
  /** Extra endpoints to try first — e.g. a keyed provider from the env. */
  preferred?: readonly string[];
  /** Per-endpoint retries before falling through to the next. */
  retryCount?: number;
  /** Initial backoff in ms; viem grows this exponentially. */
  retryDelay?: number;
};

export function arcTransport(options: ArcTransportOptions = {}): Transport {
  const { preferred = [], retryCount = 2, retryDelay = 400 } = options;

  const urls = [...new Set([...preferred, ...ARC_TESTNET_RPC_FALLBACKS])].filter(
    Boolean,
  );

  return fallback(
    urls.map((url) => http(url, { retryCount, retryDelay })),
    {
      // Do not rank by latency: ranking issues extra probe requests, which is
      // exactly what the rate limit punishes.
      rank: false,
      retryCount: 1,
    },
  );
}

/**
 * Space out sequential RPC reads.
 *
 * Even with fallback+retry, hammering the endpoints burns the quota for
 * everything that runs after. Use this between reads in scripts that walk a
 * list of addresses or orders.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
