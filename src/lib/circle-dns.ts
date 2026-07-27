/**
 * DNS pinning for Circle's hosts.
 *
 * On the network this is built from, an ISP hijacks DNS for `*.circle.com`,
 * resolving every Circle host to a local IP. The App Kit SDK's calls to the
 * CCTP fee/attestation API (`iris-api-sandbox.circle.com`) and the wallet API
 * (`api.circle.com`) then fail with a bare "fetch failed" after the SDK's own
 * retries — a network fault dressed up as an SDK error. See the memory note
 * observed live on at least one network, so this is not hypothetical.
 *
 * The fix is to resolve those hosts ourselves, out of band, and pin the result:
 *
 *   1. Resolve via DoH against Cloudflare's resolver addressed by IP literal
 *      (`1.1.1.1`), so the answer cannot be poisoned by the same local DNS that
 *      is lying about Circle.
 *   2. Patch `dns.lookup` to return that IP for Circle hosts only. Node's global
 *      `fetch`/undici, `https`, and any SDK built on them all route through
 *      `dns.lookup`, so one patch covers every Circle call.
 *   3. Leave TLS untouched. undici derives the SNI/servername from the URL host,
 *      not from the resolved address, so the certificate is still validated
 *      against `iris-api-sandbox.circle.com`. We never disable verification —
 *      doing so is exactly the trap that note warns against.
 *
 * If DoH is itself unreachable the patch steps aside and the original lookup
 * runs, so the call fails the same way it would have — loudly, and now with the
 * bridge layer naming DNS as the likely cause.
 */
import dns from "node:dns";

const CIRCLE_SUFFIX = ".circle.com";
const DOH_URL = "https://1.1.1.1/dns-query";

const cache = new Map<string, string>();
let installed = false;

function isCircleHost(hostname: string): boolean {
  return hostname === "circle.com" || hostname.endsWith(CIRCLE_SUFFIX);
}

async function resolveViaDoh(hostname: string): Promise<string | null> {
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    const a = (json.Answer ?? []).find(
      (x) => x.type === 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(x.data),
    );
    return a?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Patch `dns.lookup` so Circle hosts resolve to their real IPs. Idempotent and
 * safe to call at the top of any entrypoint that talks to Circle; the first
 * lookup of each host pays one DoH round-trip, the rest hit the cache.
 */
export function installCircleDnsPinning(): void {
  if (installed) return;
  installed = true;

  const orig = dns.lookup.bind(dns) as (
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
  ) => void;

  const patched = (
    hostname: string,
    options: unknown,
    callback?: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address?: unknown,
      family?: number,
    ) => void;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean };

    if (!isCircleHost(hostname)) return orig(hostname, options, cb);

    const respond = (ip: string) =>
      opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);

    const cached = cache.get(hostname);
    if (cached) return respond(cached);

    resolveViaDoh(hostname).then((ip) => {
      if (!ip) return orig(hostname, options, cb); // let it fail the normal way
      cache.set(hostname, ip);
      respond(ip);
    });
  };

  (dns as { lookup: unknown }).lookup = patched;
}
