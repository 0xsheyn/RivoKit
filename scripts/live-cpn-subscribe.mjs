/**
 * Register (or inspect) the CPN webhook subscription — the last mile of the
 * cash-out pipeline.
 *
 * `demo/app/api/webhooks/circle/route.ts` already verifies signatures,
 * interprets CPN events and folds them into `cpn_payments`, and
 * `src/events/webhook-handler.test.ts` covers that path against a real P-256
 * keypair. What has never happened is a webhook actually ARRIVING, because that
 * needs a public HTTPS endpoint registered with Circle.
 *
 * Two things the docs make load-bearing, both easy to get wrong:
 *   1. CPN uses notification API **v2**, whose subscription lives at
 *      `/v2/cpn/notifications/subscriptions` and requires `name` and `enabled`
 *      on top of the common fields. This is NOT the Mint `/v1/notifications`
 *      SNS flow — no SubscribeURL handshake is involved.
 *   2. Circle validates the URL with a **HEAD** request before creating the
 *      subscription. A route exporting only POST is rejected here, not later.
 *
 * Listing is read-only and runs unattended. Creating a subscription is standing
 * configuration on a live account — it makes Circle push to a URL until someone
 * deletes it — so it stays behind an explicit confirmation.
 *
 *   node scripts/live-cpn-subscribe.mjs                          # list
 *   node scripts/live-cpn-subscribe.mjs --check https://…/api/webhooks/circle
 *   CONFIRM=SUBSCRIBE node scripts/live-cpn-subscribe.mjs https://…/api/webhooks/circle
 *   CONFIRM=DELETE node scripts/live-cpn-subscribe.mjs --delete <subscriptionId>
 */
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

installCircleDnsPinning();

const env = readEnv();
const key = env.CIRCLE_CPN_KEY;
if (!key) {
  console.error("FAILED: CIRCLE_CPN_KEY missing from .env.local");
  process.exit(1);
}

// CPN platform APIs use one base URL; the key decides sandbox vs production.
const BASE = "https://api.circle.com";
const PATH = "/v2/cpn/notifications/subscriptions";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueAfter = (name) => args[args.indexOf(name) + 1];
const endpoint = args.find((a) => a.startsWith("https://"));

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, data: parsed?.data ?? parsed };
}

// ── --check: does the endpoint answer HEAD the way Circle demands? ──────
if (flag("--check")) {
  const url = valueAfter("--check") ?? endpoint;
  if (!url) {
    console.error("FAILED: --check needs an https:// URL");
    process.exit(1);
  }
  const head = await fetch(url, { method: "HEAD" }).catch((e) => ({ status: 0, statusText: e.message }));
  const post = await fetch(url, { method: "POST", body: "{}" }).catch((e) => ({ status: 0, statusText: e.message }));
  console.log(`HEAD ${url} → ${head.status} ${head.statusText ?? ""}`);
  console.log(`POST ${url} → ${post.status} (401/400 is fine here: an unsigned body must be refused)`);
  console.log(head.status === 200
    ? "\nOK — Circle's URL validation will pass."
    : "\nFAILED — Circle validates with HEAD before creating the subscription; this URL would be refused.");
  process.exit(head.status === 200 ? 0 : 1);
}

// ── --delete ───────────────────────────────────────────────────────────
if (flag("--delete")) {
  const id = valueAfter("--delete");
  if (!id) {
    console.error("FAILED: --delete needs a subscription id");
    process.exit(1);
  }
  if (process.env.CONFIRM !== "DELETE") {
    console.error(`Refusing to delete ${id} without CONFIRM=DELETE.`);
    process.exit(1);
  }
  const res = await call("DELETE", `${PATH}/${id}`);
  console.log(`DELETE ${id} → ${res.status}`);
  process.exit(res.ok ? 0 : 1);
}

// ── list (default) ─────────────────────────────────────────────────────
const list = await call("GET", PATH);
console.log(`GET ${PATH} → ${list.status}`);
const subs = Array.isArray(list.data) ? list.data : (list.data?.subscriptions ?? []);
if (!subs.length) {
  console.log("No CPN subscriptions registered — no webhook can arrive.");
} else {
  for (const s of subs) {
    console.log(`  ${s.id}  enabled=${s.enabled}  ${s.endpoint}  types=${JSON.stringify(s.notificationTypes)}`);
  }
}

if (!endpoint) {
  console.log("\nTo register one:");
  console.log("  CONFIRM=SUBSCRIBE node scripts/live-cpn-subscribe.mjs https://<public-host>/api/webhooks/circle");
  process.exit(0);
}

if (process.env.CONFIRM !== "SUBSCRIBE") {
  console.log(`\nWould register: ${endpoint}`);
  console.log("Standing configuration on a live account — re-run with CONFIRM=SUBSCRIBE to actually create it.");
  process.exit(0);
}

// Fail fast on the exact thing Circle checks, so a refusal is legible.
const head = await fetch(endpoint, { method: "HEAD" }).catch((e) => ({ status: 0, statusText: e.message }));
if (head.status !== 200) {
  console.error(`FAILED: ${endpoint} answered HEAD with ${head.status}. Circle validates the URL this way first.`);
  process.exit(1);
}

const created = await call("POST", PATH, {
  endpoint,
  name: "RivoKit cash-out webhooks",
  enabled: true,
  notificationTypes: ["*"],
});
console.log(`\nCreate subscription → ${created.status}`);
console.log(JSON.stringify(created.data, null, 2).slice(0, 800));
process.exit(created.ok ? 0 : 1);
