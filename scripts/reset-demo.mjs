/**
 * Reset the demo — delete every row its history is drawn from.
 *
 * A one-way door. Run `node scripts/backup-demo.mjs` first; it writes a
 * timestamped JSON of all four tables into `docs/` (gitignored) in seconds.
 *
 * WHY `cpn_payments` IS DELETED EXPLICITLY
 *
 * This used to delete orders and stop, on the reasoning that everything else
 * cascades. Two of the three do — `payments` and `events` are both
 * `ON DELETE CASCADE`. `cpn_payments.order_id` is `ON DELETE SET NULL`, and
 * that difference is deliberate: a broadcast CPN payment is real whether or not
 * the order that triggered it still exists, so the schema refuses to let an
 * order's deletion erase it.
 *
 * The consequence for a reset was worse than leaving the rows alone. `order_id`
 * is exactly what the history panel reads to tell a release payout from a
 * manual cash-out, so deleting orders alone did not leave those CPN rows
 * untouched — it left rows that now CLAIM to be standalone cash-outs. A cleared
 * demo would open showing payments nobody made, from a panel nobody used.
 *
 * So they go first, and by their own id rather than through the order.
 *
 * AND WHY `events` IS TOO
 *
 * `events.order_id` CASCADES, which covers every event an order owns and none
 * of the rest. An event may legitimately have no order: a verified CPN webhook
 * that arrived before anything could be matched to it, a `cpn.reconcile.*`
 * audit row, a `webhooks.test` ping. Those have no parent, so nothing deletes
 * them, and a "cleared" database kept answering with rows from previous weeks.
 *
 * Emptying the table is therefore the honest reading of a reset — and the one
 * to be careful about, because those unattributed rows include the
 * signature-verified webhook deliveries that `PROOFS.md` cites. Back up first;
 * `backup-demo.mjs` captures them.
 *
 *   node scripts/reset-demo.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error("FAILED: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env.local");
  process.exitCode = 1;
} else {
  const db = createClient(url, key, { auth: { persistSession: false } });

  const TABLES = ["orders", "payments", "events", "cpn_payments"];
  const counts = async () => {
    const out = {};
    for (const t of TABLES) {
      out[t] = (await db.from(t).select("*", { count: "exact", head: true })).count ?? 0;
    }
    return out;
  };
  const line = (label, c) => `${label} → ${TABLES.map((t) => `${t}: ${c[t]}`).join(", ")}`;

  console.log(line("before", await counts()));

  /*
   * In this order, and the order is the design:
   *
   *   cpn_payments — first, because `orders` would otherwise SET NULL on the
   *                  very rows about to go. Harmless in itself, but a failure
   *                  between the two steps would leave exactly the "everything
   *                  looks like a manual cash-out" state described above.
   *   events       — the whole table, not just what an order owns. `id` is a
   *                  uuid, so `neq` against the nil uuid matches every row.
   *   orders       — last. `payments` cascades away with it.
   */
  const STEPS = [
    { table: "cpn_payments", column: "payment_id", notValue: "" },
    { table: "events", column: "id", notValue: "00000000-0000-0000-0000-000000000000" },
    { table: "orders", column: "id", notValue: "" },
  ];

  let failed = false;
  for (const { table, column, notValue } of STEPS) {
    const { error } = await db.from(table).delete().neq(column, notValue);
    if (error) {
      // Stop at the first failure rather than pressing on. A half-cleared demo
      // is the one outcome worse than an uncleared one: it looks finished.
      console.error(`FAILED to delete ${table}: ${error.message}`);
      failed = true;
      break;
    }
  }

  console.log(line("after ", await counts()));

  if (failed) {
    process.exitCode = 1;
    console.error("\nReset INCOMPLETE — the counts above say what survived.");
  } else {
    console.log("\nDemo history cleared.");
    // Said every time, because it is the one thing a "cleared" demo still
    // shows, and the surprise is otherwise saved for whoever opens the page.
    console.log(
      "Circle Mint's redemption list is NOT cleared — those are Circle's own records of real\n" +
        "redemptions, read live from their API. The Mint history panel will still show them.",
    );
  }
}
