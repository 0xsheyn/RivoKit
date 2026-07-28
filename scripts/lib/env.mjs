/**
 * Locates and parses the repo-root `.env.local` for the scripts.
 *
 * Scripts used to read `.env.local` relative to the cwd, which only worked when
 * they were launched from the repo root. `.env.local` is gitignored, so
 * `git worktree add` never copies it — a script run inside
 * `.claude/worktrees/<name>/` died on `ENOENT` even though the file existed
 * three directories up. Resolution starts from this file's own location (not
 * the cwd) and walks up, so the primary checkout's `.env.local` stays the one
 * source of truth for scripts, the demo, and every worktree.
 *
 * Nothing here reads or logs a value — callers pick the keys they need.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** The checkout this file belongs to — scripts/lib/env.mjs → two levels up. */
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Deep enough for `.claude/worktrees/<name>/`, shallow enough not to wander. */
const MAX_DEPTH = 8;

/** Directory holding `.env.local`, or null when there is none. */
export function findRoot() {
  let dir = CHECKOUT_ROOT;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (existsSync(join(dir, ".env.local"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
  return null;
}

/** Where `.env.local` lives — or, when absent, where it should be created. */
export function envPath() {
  return join(findRoot() ?? CHECKOUT_ROOT, ".env.local");
}

/** Resolve a path against the checkout that owns `.env.local`. */
export function fromRoot(...parts) {
  return resolve(findRoot() ?? CHECKOUT_ROOT, ...parts);
}

/**
 * `.env.local` parsed into a plain object.
 *
 * Exits with the caller's remedy when the file is missing, rather than letting
 * a bare ENOENT surface as if the script itself were broken. Pass
 * `{ required: false }` to get `{}` instead.
 */
export function readEnv({ required = true, hint = "node scripts/sync-env.mjs" } = {}) {
  const root = findRoot();
  if (!root) {
    if (!required) return {};
    console.error(`FAILED: .env.local is missing (searched ${CHECKOUT_ROOT} and up). Run: ${hint}`);
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) env[m[1]] = m[2];
  }
  return env;
}

let merged = false;

/**
 * Merges `.env.local` into `process.env` — what the demo's server modules need,
 * since Next only loads `.env` from the app dir (`demo/`). A value already in
 * the real environment always wins, and a missing file is not fatal: the
 * caller's own `need()` reports which key it was actually looking for.
 */
export function loadRootEnv() {
  if (merged) return;
  merged = true;
  for (const [key, value] of Object.entries(readEnv({ required: false }))) {
    if (process.env[key] == null) process.env[key] = value;
  }
}
