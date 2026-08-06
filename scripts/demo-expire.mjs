/**
 * Age an unpaid order's authorization window so the expiry path can be walked
 * without waiting an hour.
 *
 * `preApprovalExpiry` is one hour from checkout (`expiriesFor`). Past it the
 * escrow REFUSES to collect, and the demo says so: every payment control
 * disappears and the only thing left is "Close order". That is a real branch
 * with a real guard behind it (`mpExpireOrder` refuses anything that is not
 * `created`/`funding_pending` AND already past its expiry), and an hour of
 * waiting is a poor way to rehearse it.
 *
 * WHAT THIS ACTUALLY CHANGES, AND WHY IT IS SAFE ONLY HERE
 *
 * `pre_approval_expiry` is not a display field. It is part of `PaymentInfo`,
 * which is hashed into the payment's on-chain identity — so editing it gives
 * the order a DIFFERENT hash from the one any existing on-chain payment was
 * created under. For a funded order that would be corruption: the record would
 * point at a payment that does not exist, and every later escrow call would
 * address the wrong thing.
 *
 * It is safe on a `created` order for exactly one reason: nothing is on-chain
 * yet. No authorization has been signed, no payment exists, so there is no hash
 * to disagree with. Hence the two guards below — the state, and the absence of
 * any payment row — and hence the refusal to touch `funding_pending`, where
 * money may be in flight even though nothing has been recorded.
 *
 * The order becomes permanently unpayable. That IS the scenario. The previous
 * value is printed so it can be put back:
 *
 *   node scripts/demo-expire.mjs ord_123                       # age it
 *   node scripts/demo-expire.mjs ord_123 --restore <iso>       # put it back
 */
import { createClient } from "@supabase/supabase-js";
import { readEnv } from "./lib/env.mjs";

const env = readEnv();

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY;
const orderId = process.argv[2];
const restoreFlag = process.argv.indexOf("--restore");
const restoreTo = restoreFlag > -1 ? process.argv[restoreFlag + 1] : null;

if (!url || !key) {
  console.error("FAILED: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env.local");
  process.exitCode = 1;
} else if (!orderId) {
  console.error("Usage: node scripts/demo-expire.mjs <orderId> [--restore <iso>]");
  process.exitCode = 1;
} else if (restoreFlag > -1 && (!restoreTo || Number.isNaN(Date.parse(restoreTo)))) {
  console.error("--restore needs the ISO timestamp this script printed when it aged the order.");
  process.exitCode = 1;
} else {
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: order, error } = await db
    .from("orders")
    .select("id, state, pre_approval_expiry")
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`FAILED: ${error.message}`);
    process.exitCode = 1;
  } else if (!order) {
    console.error(`No order stored under ${orderId}.`);
    process.exitCode = 1;
  } else if (order.state !== "created") {
    // `funding_pending` is refused too, and that is not an oversight: it means a
    // rail was started, so USDC may be moving toward an escrow that would then
    // be addressed by a hash this edit had changed.
    console.error(
      `REFUSED: ${orderId} is ${order.state}, not created.\n` +
        "  pre_approval_expiry is hashed into the payment's on-chain identity, so editing it on an order\n" +
        "  that has touched the chain would point the record at a payment that does not exist.",
    );
    process.exitCode = 1;
  } else {
    // Belt and braces against the state column being wrong: a payment row is
    // direct evidence that something already happened on-chain.
    const { count } = await db
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);

    if ((count ?? 0) > 0) {
      console.error(
        `REFUSED: ${orderId} says created but already has ${count} payment row(s) — something reached the chain.`,
      );
      process.exitCode = 1;
    } else {
      // A minute into the past, not an hour: far enough that every `<= now`
      // check agrees, close enough that the printed timestamps stay readable.
      const next = restoreTo ?? new Date(Date.now() - 60_000).toISOString();
      const { error: writeError } = await db
        .from("orders")
        .update({ pre_approval_expiry: next })
        .eq("id", orderId);

      if (writeError) {
        console.error(`FAILED: ${writeError.message}`);
        process.exitCode = 1;
      } else {
        console.log(`${orderId}`);
        console.log(`  was  ${order.pre_approval_expiry}`);
        console.log(`  now  ${next}`);
        if (restoreTo) {
          console.log("\nRestored. The order is payable again.");
        } else {
          console.log(
            "\nThe order now reads as expired: every payment control is gone and only \"Close order\" remains.\n" +
              `Put it back with:  node scripts/demo-expire.mjs ${orderId} --restore ${order.pre_approval_expiry}`,
          );
        }
      }
    }
  }
}
