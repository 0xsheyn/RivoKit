import { Newsreader, Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";

// Display — serif italic, used only for the wordmark, section headlines and
// state captions. Never for numbers (see §2 of RIVO_LP.md: mono is for proof).
export const displaySerif = Newsreader({
  subsets: ["latin"],
  style: ["italic"],
  weight: ["400", "500", "600"],
  variable: "--landing-serif",
  display: "swap",
});

// Chrome — plain Inter, for the parts of the page that frame it rather than say
// anything: the topbar wordmark and its nav links. Deliberately NOT the body
// face: chrome that shares the body's font stops reading as a deliberate choice
// and starts reading as an oversight, which is what happened when these links
// merely dropped off the mono face.
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
