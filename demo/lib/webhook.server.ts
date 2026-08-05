/**
 * The webhook route's wiring — everything it needs and nothing it does not.
 *
 * WHY THIS IS SEPARATE FROM `rivokit.server.ts`. The route used to call
 * `getRivoKit()`, which builds the whole demo: App Kit, the viem adapters, the
 * Circle Wallets adapter. That last one depends on `@solana/web3.js`, which
 * depends on `rpc-websockets`, whose CommonJS entry `require()`s an ESM `uuid`.
 * Marked as a `serverExternalPackage` (see `demo/next.config.mjs`) it is not
 * bundled, so Node hits that clash at runtime and the MODULE FAILS TO LOAD:
 *
 *   ERR_REQUIRE_ESM — require() of ES Module rpc-websockets/…/uuid from
 *   rpc-websockets/dist/index.cjs        page: /api/webhooks/circle
 *
 * Observed in production 2026-08-05 as a 500 on every request to the route,
 * including the `HEAD` Circle uses to validate a subscription. The route's
 * `HEAD` handler was correct and returned 200 — it simply never ran, because
 * nothing in the module got as far as executing. A correct handler behind a
 * module that cannot load is indistinguishable from a missing one.
 *
 * The fix is not a bundler flag. A webhook receiver has no business importing a
 * swap SDK, a bridge, or a Solana client: it verifies a signature and writes a
 * row. Two dependencies, both light — Supabase for the store, and Circle's REST
 * API for the signing key. Keeping it that way is also what stops the next
 * heavy dependency added to `rivokit.server.ts` from silently breaking this
 * route again.
 */
import { createCircleClient } from "../../scripts/lib/circle.mjs";
import { loadRootEnv } from "../../scripts/lib/env.mjs";
import { installCircleDnsPinning } from "../../src/lib/circle-dns.ts";
import { createOrderStore } from "../../src/orchestrator/order-store.ts";

loadRootEnv();

// This network hijacks Circle's DNS — pin before any Circle call.
installCircleDnsPinning();

const need = (key: string): string => {
  const v = process.env[key];
  if (v == null || v === "") throw new Error(`env ${key} is empty — check .env.local`);
  return v;
};

let cached: ReturnType<typeof build> | null = null;

function build() {
  const circle = createCircleClient({
    apiKey: need("CIRCLE_API_KEY"),
    // The entity secret is not used for reading public keys, but the client
    // asks for it up front and refuses to construct without one. Cheaper to
    // supply it than to fork the client for one endpoint.
    entitySecret: need("CIRCLE_ENTITY_SECRET"),
  });
  const store = createOrderStore(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"));

  /**
   * Resolve the public key that signed a webhook.
   *
   * The signature scheme is shared across v2 products but the KEY ENDPOINT is
   * not: Wallets/Contracts/Gateway live at `/v2/notifications/publicKey/{id}`
   * while CPN lives at `/v2/cpn/notifications/publicKey/{id}`. Asking the wrong
   * one returns 404 `API parameter invalid`, so every CPN webhook would have
   * been refused `401 unverifiable` — an endpoint that looks wired while being
   * incapable of accepting a single CPN event. Verified against live traffic.
   *
   * Both paths authenticate with CIRCLE_API_KEY. CIRCLE_CPN_KEY is 403 here,
   * the same capability gap it hits on the subscriptions API.
   */
  const resolveWebhookPublicKey = async (
    keyId?: string,
    product: "cpn" | "wallets" = "wallets",
  ): Promise<string | null> => {
    if (!keyId) return null;
    const paths = {
      cpn: `/v2/cpn/notifications/publicKey/${keyId}`,
      wallets: `/v2/notifications/publicKey/${keyId}`,
    };
    // Try the expected product first, then the other. The caller infers the
    // product from `notificationType`, which is right for real events but wrong
    // for the `webhooks.test` Circle fires at a brand-new subscription: that
    // type carries no `cpn.` prefix while its key id belongs to the CPN
    // subscription that triggered it. Guessing from the body alone answered 401
    // to the very first thing Circle ever sends — and repeated failures are how
    // a subscription gets disabled.
    for (const p of [product, product === "cpn" ? "wallets" : "cpn"] as const) {
      try {
        const data = await circle.request("GET", paths[p]);
        const key = (data?.publicKey as string | undefined) ?? null;
        if (key) return key;
      } catch {
        // 404 here means "wrong product for this key id" — try the other.
      }
    }
    return null;
  };

  return { store, resolveWebhookPublicKey };
}

/** Built once per process, like `getRivoKit()` — the store holds a connection. */
export function getWebhookDeps() {
  cached ??= build();
  return cached;
}
