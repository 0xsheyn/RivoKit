/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The SDK lives outside this app's directory (../src), so transpile it here.
  transpilePackages: [],
};

export default nextConfig;
