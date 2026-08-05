/**
 * Where a live script keeps the state that lets an interrupted run CONTINUE.
 *
 * These files are the difference between resuming a half-finished run and
 * starting a second one. A CCTP bridge whose burn has landed but whose mint has
 * not is the sharp case: re-running from scratch burns a second amount instead
 * of recovering the first, so the file holding `startedAt` is what stands
 * between an interruption and a double spend.
 *
 * TWO THINGS THIS FIXES.
 *
 * They used to be sixteen bare relative paths — `.live-sdk.json` and friends —
 * scattered across `scripts/`. Relative paths resolve against the CWD, so the
 * same script run from the repo root and from a subdirectory kept two different
 * state files, and the second one always looked like a fresh run. That is the
 * same trap `env.mjs` documents for `.env.local`, and it is worse here, because
 * a state file that reads as empty does not fail — it silently re-does work that
 * costs money.
 *
 * They also all sat in the repo root, fifteen dotfiles deep. Now they live in
 * one directory, which is `.gitignore`d as a whole rather than by a glob that
 * has to be kept in sync with the filenames.
 *
 * NOT a cache: deleting one is not free. It means the next run of that script
 * starts over, which for the spending ones means spending again.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findRoot } from "./env.mjs";

/** One directory, anchored to the checkout — never to wherever you happened to be. */
export const STATE_DIR = join(findRoot() ?? process.cwd(), ".live-state");

/**
 * Absolute path for a script's state file, creating the directory on first use.
 *
 * `name` is the bare script name — `stateFile("live-sdk")` → `<root>/.live-state/live-sdk.json`.
 */
export function stateFile(name) {
  mkdirSync(STATE_DIR, { recursive: true });
  return join(STATE_DIR, `${name}.json`);
}
