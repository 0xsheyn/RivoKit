import { Newsreader, Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";

// Display — serif italic: section headlines, state captions, and now the
// navigation at both ends of the page (topbar links, footer links). Never for
// numbers (see §2 of RIVO_LP.md: mono is for proof).
export const displaySerif = Newsreader({
  subsets: ["latin"],
  style: ["italic"],
  weight: ["400", "500", "600"],
  variable: "--landing-serif",
  display: "swap",
});

// Chrome — plain Inter, and now only for the topbar's logotype. The nav links
// it also used to set moved to the display serif; what is left is the wordmark,
// which should stay upright: an italic serif "rivokit" beside the mark reads as
// a phrase, not as a name.
export const uiSans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--landing-ui",
  display: "swap",
});

// Body & UI — grotesk, 400/500 only, no bold.
export const bodySans = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--landing-sans",
  display: "swap",
});

// Utility & data — tabular mono. Every money value, tx hash and status uses this.
export const utilityMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--landing-mono",
  display: "swap",
});
