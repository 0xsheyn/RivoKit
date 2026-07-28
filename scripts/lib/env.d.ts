// Types for the plain-JS .env.local locator (env.mjs), so TS consumers
// (the demo server modules) import it typed.

/** Directory holding `.env.local`, or null when there is none. */
export function findRoot(): string | null;

/** Where `.env.local` lives — or, when absent, where it should be created. */
export function envPath(): string;

/** Resolve a path against the checkout that owns `.env.local`. */
export function fromRoot(...parts: string[]): string;

/** `.env.local` parsed into a plain object. */
export function readEnv(options?: { required?: boolean; hint?: string }): Record<string, string>;

/** Merge `.env.local` into `process.env` without overwriting real env vars. */
export function loadRootEnv(): void;
