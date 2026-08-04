/**
 * The runtime dependency list, in one place.
 *
 * It used to be a local const inside `demo/app/docs/page.tsx`. Two surfaces now
 * render it — the docs §02 table and the landing ticker — and a second copy is
 * a second thing to forget when a version bumps. Same reasoning as `NAV` in
 * `Topbar.tsx`, which the footer imports rather than retyping.
 *
 * `items` is the human-readable cell for the table; `PACKAGES` below splits it
 * back into individual names for the ticker, so the two can never disagree
 * about what is installed.
 */
export const STACK: Array<{ layer: string; items: string; why: string }> = [
  {
    layer: "Language & runtime",
    items: "TypeScript 5.9 · Node ≥ 20 · ESM only",
    why: "Money is bigint minor units end to end; `exactOptionalPropertyTypes` is on.",
  },
  {
    layer: "Chain access",
    items: "viem 2.38 · wagmi 2.17",
    why: "viem ships `arcTestnet`; wagmi drives the browser wallet through EIP-6963 discovery.",
  },
  {
    layer: "Circle — swap, bridge, balance",
    items: "@circle-fin/app-kit 1.10 · adapter-viem-v2 · adapter-circle-wallets",
    why: "StableFX is reached through App Kit `swap`, not a separate FX contract. Also Gateway unified balance and CCTP.",
  },
  {
    layer: "Circle — contracts & wallets",
    items: "@circle-fin/smart-contract-platform 10.8",
    why: "Deploys the pinned Commerce Payments Protocol artifacts and runs the operator's developer-controlled wallet.",
  },
  {
    layer: "Off-ramp crypto",
    items: "jose 6.2",
    why: "JWE encryption for CPN beneficiary data; EIP-712 witness signing is done with viem.",
  },
  {
    layer: "Persistence",
    items: "Supabase (supabase-js 2.58) · Postgres",
    why: "Invariants live as CHECK constraints, not only as application code. Migrations ship inside the package.",
  },
  {
    layer: "Demo app",
    items: "Next.js 15.5 · React 19.1 · Tailwind 4.3 · shadcn · @base-ui/react",
    why: "App Router with server actions. The demo is proof of function, not the product.",
  },
  {
    layer: "Tests",
    items: "vitest 3.2",
    why: "Unit tests need no credentials; anything touching a chain is a live-proof script instead.",
  },
];

/**
 * Every package name on its own, derived rather than retyped.
 *
 * "Supabase (supabase-js 2.58)" collapses to "supabase-js 2.58" — the ticker
 * wants the installed name, and the parenthetical exists only to tell a reader
 * of the table which product the package belongs to.
 */
export const PACKAGES: string[] = STACK.flatMap((s) =>
  s.items.split("·").map((item) => item.trim().replace(/^\w[\w\s]*\((.+)\)$/, "$1")),
);
