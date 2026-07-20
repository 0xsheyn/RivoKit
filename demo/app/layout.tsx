import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RivoKit — demo",
  description:
    "Cross-border settlement on Arc: multi-chain USDC in, floored EURC out. Testnet only.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
