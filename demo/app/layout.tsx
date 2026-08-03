import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";

// shadcn/ui default pairing. The preset's `@theme inline` reads --font-sans,
// --font-heading and --font-mono straight through, so the variables are named
// for the token they feed and the utilities resolve to Geist.
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

// `font-heading` is what CardTitle renders in, so the variable has to be fed or
// the utility resolves to nothing.
//
// Preset `b3tMtm245o` pairs Geist MONO as that face, which is why every card
// title across the demo came out monospaced. The demo is dense with cards and
// nested cards; a monospaced title on each one reads as code rather than as a
// heading, and its wider glyphs cost the truncated titles real characters. So
// the heading face is the body face — same family, weight carries the hierarchy.
// This is a deliberate departure from the preset; `globals.css` is where the
// CLI's token block lives and fonts are wired by hand here.
const geistHeading = Geist({
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RivoKit — demo",
  description:
    "Cross-border settlement on Arc: multi-chain USDC in, floored EURC out. Testnet only.",
  // The icon lives in `public/`, not as the `app/favicon.ico` file convention,
  // so that this URL is the only one emitted and it can carry a version.
  // Browsers keep favicons in a store of their own — keyed by origin, and not
  // evicted by a hard reload — so an origin that once served no icon keeps
  // showing none. The query string is a URL the cache has no entry for. Bump
  // `v` if the artwork itself ever changes.
  icons: { icon: [{ url: "/favicon.ico?v=2", type: "image/x-icon" }] },
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
        className={`${geistSans.variable} ${geistMono.variable} ${geistHeading.variable} min-h-screen bg-background font-sans text-foreground antialiased`}
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
