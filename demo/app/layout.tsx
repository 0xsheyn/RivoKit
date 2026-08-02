import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";

// shadcn/ui default pairing. The preset's `@theme inline` reads --font-sans and
// --font-mono straight through, so the variables are named for the token they
// feed and the `font-sans` / `font-mono` utilities resolve to Geist.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

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
      {/*
       * `suppressHydrationWarning` covers THIS element's own attributes only —
       * not its descendants — so a real mismatch anywhere in the app still
       * reports. It is here because wallet and writing-assistant extensions
       * decorate <body> before React hydrates, and that is not something the
       * app can render its way out of.
       */}
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-background font-sans text-foreground antialiased`}
      >
        <Providers>{children}</Providers>
        {/* Bottom-right, and deliberately not auto-dismissing for work in
            flight: a toast that disappears before the bridge finishes is worse
            than none, because it says "done" when nothing is. */}
        {/* `theme` is pinned because the demo ships no ThemeProvider: the
            preset Toaster asks next-themes and would follow the OS into dark
            while the page itself — which never gets the `.dark` class — stays
            light. Drop this the day a theme toggle lands. */}
        <Toaster position="bottom-right" closeButton theme="light" />
      </body>
    </html>
  );
}
