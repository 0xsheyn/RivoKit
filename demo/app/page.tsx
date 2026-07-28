import "./landing/landing.css";
import { displaySerif, bodySans, utilityMono } from "./landing/fonts";
import Hero from "./landing/Hero";
import BuiltOn from "./landing/BuiltOn";
import Capabilities from "./landing/Capabilities";
import OrderStates from "./landing/OrderStates";
import ThesisBand from "./landing/ThesisBand";
import Numbers from "./landing/Numbers";
import Ticker from "./landing/Ticker";
import Proof from "./landing/Proof";
import CtaInstall from "./landing/CtaInstall";
import Footer from "./landing/Footer";

export const metadata = {
  title: "RivoKit — cross-border settlement on Arc",
  description:
    "An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out. Floored FX quote, escrow, refunds, and a real fiat exit.",
};

export default function LandingPage() {
  return (
    <div className={`rivo-landing ${displaySerif.variable} ${bodySans.variable} ${utilityMono.variable}`}>
      <Hero />
      <BuiltOn />
      <Capabilities />
      <OrderStates />
      <ThesisBand />
      <Numbers />
      <Ticker />
      <Proof />
      <CtaInstall />
      <Footer />
    </div>
  );
}
