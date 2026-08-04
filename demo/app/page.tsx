import "./landing/landing.css";
import { displaySerif, bodySans, uiSans, utilityMono } from "./landing/fonts";
import Hero from "./landing/Hero";
import Problem from "./landing/Problem";
import BuiltOn from "./landing/BuiltOn";
import Capabilities from "./landing/Capabilities";
import TwoEndings from "./landing/TwoEndings";
import ThesisBand from "./landing/ThesisBand";
import Ticker from "./landing/Ticker";
import Proof from "./landing/Proof";
import Roadmap from "./landing/Roadmap";
import Faq from "./landing/Faq";
import { RailDivider } from "./landing/Rail";
import CtaInstall from "./landing/CtaInstall";
import Footer from "./landing/Footer";
import Topbar from "./landing/Topbar";

export const metadata = {
  title: "RivoKit — cross-border settlement on Arc",
  description:
    "An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out. Floored FX quote, escrow, refunds, and a real fiat exit.",
};

export default function LandingPage() {
  return (
    <div
      id="top"
      className={`rivo-landing ${displaySerif.variable} ${bodySans.variable} ${uiSans.variable} ${utilityMono.variable}`}
    >
      {/* Why → what it's built on → what it does → where the money ends up →
          the thesis → the proof and its limits → what's next → the operational
          questions → install. The problem comes BEFORE the toolbox; the page
          used to open on its dependencies, which only reads as an argument to
          someone who already agreed with it. The FAQ sits last on purpose: it
          answers what a reader asks once they have decided to try it, and
          nothing it asks is re-asked from above.
          Two sections were cut rather than renumbered in place — "one order,
          its states" and "the numbers". Both said things the page says better
          elsewhere: the order's own figures and capture hash are a row in the
          proof ledger, and each of the three numbers survives in the FAQ, the
          install CTA and the ticker. */}
      {/* The rails stand BETWEEN sections rather than inside them — see
          Rail.tsx. Two plain sections in a row get one; a section followed by a
          full-bleed band does not, because the band draws its own edge. */}
      <Topbar />
      <Hero />
      <Problem />
      <RailDivider />
      <BuiltOn />
      <RailDivider />
      <Capabilities />
      <RailDivider />
      <TwoEndings />
      <ThesisBand />
      <Ticker />
      <Proof />
      <RailDivider />
      <Roadmap />
      <RailDivider />
      <Faq />
      <CtaInstall />
      <Footer />
    </div>
  );
}
