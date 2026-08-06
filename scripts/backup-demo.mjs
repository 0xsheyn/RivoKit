/**
 * Snapshot every row the demo's history is drawn from, before clearing it.
 *
 * `reset-demo.mjs` is a one-way door. This is the thing that has to run first,
 * and it existed only as a hand-rolled dump someone did once
 * (`docs/db-backup-2026-08-02T01-55-02-920Z.json`) — a shape worth keeping and a
 * procedure worth not re-inventing under pressure.
 *
 * WHAT IT CAN AND CANNOT SAVE
 *
 * Four tables are ours and are captured whole: `orders`, `payments`, `events`,
 * `cpn_payments`. Everything the marketplace, the withdraw page and both
 * history panels render comes from those.
 *
 * Circle Mint's redemption list does NOT. It is Circle's record of real
 * redemptions against the Mint account, read live over the API every time the
 * panel renders. It is captured here for the record, and it is worth being
 * plain about the consequence: `reset-demo` cannot delete it, so the Mint
 * history panel keeps showing those rows after a reset. That is not a bug in
 * the reset — it is what "someone else's ledger" means.
 *
 * READ-ONLY. Nothing here writes to the database or to Circle.
 *
 *   node scripts/backup-demo.mjs                    # → docs/db-backup-<iso>.json
 *   node scripts/backup-demo.mjs path/to/file.json  # somewhere else
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  // Every table the demo reads, each ordered oldest-first so the file reads as
  // a timeline rather than as whatever order PostgREST felt like returning.
  const TABLES = [
    { name: "orders", order: "created_at" },
    { name: "payments", order: "created_at" },
    { name: "events", order: "received_at" },
    { name: "cpn_payments", order: "created_at" },
  ];

  /**
   * Paged, because PostgREST caps a response at 1000 rows and does it SILENTLY
   * — a backup that stops at row 1000 looks exactly like a complete one, and
   * the moment you find out is the moment you need it.
   */
  async function dump(table, orderBy) {
    const rows = [];
    const PAGE = 500;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from(table)
        .select("*")
        .order(orderBy, { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE) return rows;
    }
  }

  const tables = {};
  const counts = {};
  let failed = false;

  for (const { name, order } of TABLES) {
    try {
      tables[name] = await dump(name, order);
      counts[name] = tables[name].length;
    } catch (e) {
      // Recorded, never swallowed. A backup missing a table must not be written
      // as though it were whole — the whole point of the file is being trusted
      // later, by someone who cannot re-check it.
      console.error(`FAILED to read ${name}: ${String(e?.message ?? e)}`);
      failed = true;
    }
  }

  // Circle's own ledger. Captured for the record; it survives a reset either
  // way, because deleting it is not something this repo can do.
  let mintPayouts = null;
  let mintError = null;
  try {
    const { mintPayouts: readMintPayouts } = await import("../demo/lib/mint.server.ts");
    mintPayouts = await readMintPayouts(100);
    counts["circle_mint_payouts"] = mintPayouts.length;
  } catch (e) {
    mintError = String(e?.message ?? e);
    console.warn(`Circle Mint payouts not captured: ${mintError.slice(0, 140)}`);
  }

  if (failed) {
    console.error("\nNothing written. Fix the read above and run again — a partial backup is worse than none.");
    process.exitCode = 1;
  } else {
    const takenAt = new Date().toISOString();
    const out =
      process.argv[2] ??
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "docs",
        `db-backup-${takenAt.replace(/[:.]/g, "-")}.json`,
      );

    writeFileSync(
      out,
      `${JSON.stringify(
        {
          takenAt,
          counts,
          tables,
          // Named apart from `tables` on purpose: these are not ours, and a
          // restore must never try to write them back.
          external: {
            note:
              "Circle Mint's own redemption records, read from api-sandbox.circle.com. " +
              "reset-demo cannot delete these — the Mint history panel keeps showing them.",
            circle_mint_payouts: mintPayouts,
            ...(mintError ? { error: mintError } : {}),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    for (const [name, n] of Object.entries(counts)) {
      console.log(`  ${String(n).padStart(5)}  ${name}`);
    }
    console.log(`\nWritten to ${out}`);
    console.log("`docs/` is gitignored — this file stays local, which is where credentials-adjacent data belongs.");
  }
}
