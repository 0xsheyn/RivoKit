/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // These are heavy, Node-oriented packages the demo touches only in server
  // actions (the RivoKit wiring). Keep them external so Next does not try to
  // bundle them for the browser or trip over their Node-only internals.
  serverExternalPackages: [
    "@circle-fin/app-kit",
    "@circle-fin/adapter-viem-v2",
    "@circle-fin/adapter-circle-wallets",
    "@supabase/supabase-js",
  ],
};

export default nextConfig;
