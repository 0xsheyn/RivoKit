/**
 * Reset the demo — delete all orders (payments & events cascade).
 *
 * Uses the app's own Supabase service-role key. Handy between demos so the
 * marketplace starts clean.
 *
 *   node scripts/reset-demo.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("FAILED: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env.local");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const count = async (t) => (await db.from(t).select("id", { count: "exact", head: true })).count ?? 0;

console.log(`before → orders: ${await count("orders")}, payments: ${await count("payments")}, events: ${await count("events")}`);

const { error } = await db.from("orders").delete().neq("id", "");
if (error) {
  console.error("FAILED to delete:", error.message);
  process.exit(1);
}

console.log(`after → orders: ${await count("orders")}, payments: ${await count("payments")}, events: ${await count("events")}`);
console.log("Demo history cleared.");
