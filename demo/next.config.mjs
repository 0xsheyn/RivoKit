/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Heavy, Node-oriented packages the demo touches only in server actions (the
  // RivoKit wiring). External means Next leaves them to Node at runtime instead
  // of bundling them into the server output.
  //
  // `@circle-fin/adapter-circle-wallets` is deliberately NOT in this list, and
  // removing it is what made the deployed demo work at all. Unbundled, Node
  // loads it as ESM and it breaks twice over:
  //
  //   1. its `@solana/web3.js` chain reaches `rpc-websockets`, whose CommonJS
  //      build `require()`s an ESM `uuid` — ERR_REQUIRE_ESM. (Also addressed by
  //      the `overrides` in package.json, which is kept: it fixes the require
  //      itself rather than hiding it behind a bundler.)
  //   2. its own ESM entry does a NAMED import from
  //      `@circle-fin/developer-controlled-wallets`, which is CommonJS —
  //      `SyntaxError: Named export 'Blockchain' not found`. Node cannot always
  //      infer named exports from CJS; a bundler can.
  //
  // Both were invisible locally — every route answered 200 here — and appeared
  // only in the Vercel lambda, at 42 to 131 errors per deploy. Bundling it lets
  // webpack do the CJS/ESM interop that Node declines to do.
  //
  // This does not ship it to the browser: `serverExternalPackages` only governs
  // the SERVER bundle, and the adapter is reached solely from `.server.ts`
  // modules and server actions.
  serverExternalPackages: [
    "@circle-fin/app-kit",
    "@circle-fin/adapter-viem-v2",
    "@supabase/supabase-js",
  ],
};

export default nextConfig;
