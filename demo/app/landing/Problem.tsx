import SectionHeader from "./SectionHeader";

/**
 * The section this page spent its whole life without.
 *
 * It used to open on "BUILT ON" — the tools, before the reason. A reader was
 * told which four protocols are composed before being told what the composition
 * is for, which is the wrong order for everyone who does not already know.
 *
 * Content is condensed from README > The problem it solves. Three frictions,
 * because they converge on one point: each is survivable alone, and together
 * they are why platforms end up building a payments company they never wanted.
 */
const FRICTIONS = [
  {
    n: "i",
    title: "The payer's balance is scattered. The recipient does not want crypto.",
    body:
      "A crypto-native business holds USDC across many chains. A European contractor wants euros in a bank account. Bridging that today means manual off-ramps, opaque FX, and a settlement path the platform has to babysit.",
  },
  {
    n: "ii",
    title: "The recipient needs certainty, not a rate.",
    body:
      "They want a guaranteed local amount — not exposure to whatever FX does between checkout and settlement. “Best effort” is not a payment.",
  },
  {
    n: "iii",
    title: "Platforms must assemble the plumbing themselves.",
    body:
      "Bridging + escrow + FX + payout across four protocols, each with its own failure mode, none of them the platform's core competency — and then the parts turn out not to compose. CPN accepts USDC only, so a settlement that ends in EURC cannot be off-ramped through it at all. That is the kind of thing you find after building both halves.",
  },
];

export default function Problem() {
  return (
    <section id="problem" className="mx-auto w-full max-w-[1440px] scroll-mt-[92px] px-5 py-8 md:scroll-mt-[100px] md:px-16">
      <SectionHeader number="01" title="THE PROBLEM IT SOLVES" />

      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-12">
        <h2 className="f-display text-[34px] leading-[0.95] text-[var(--bone)] md:col-span-6 md:text-[44px]">
          Three frictions, one point.
        </h2>
        <p className="text-[15px] leading-relaxed text-[var(--bone)]/80 md:col-span-6 md:col-start-8">
          Paying someone across a border in their own currency is not one hard problem. It is three, and they all land
          on the same platform — the one that just wanted to pay its sellers.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm bg-[color:var(--ash)]/15 md:grid-cols-3">
        {FRICTIONS.map((f) => (
          <div key={f.n} className="hover-step hover-accent bg-[var(--ink-raised)] p-5">
            <p className="f-mono text-[12px] text-[var(--sodium)]">{f.n}</p>
            <p className="f-display mt-3 text-[19px] leading-tight text-[var(--bone)]">{f.title}</p>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--bone)]/70">{f.body}</p>
          </div>
        ))}
      </div>

      <p className="mt-8 max-w-3xl text-[15px] leading-relaxed text-[var(--bone)]/85">
        RivoKit closes all three: the payer pays from any chain, the recipient is guaranteed their number and can be
        paid into a bank without a second manual step, and the platform{" "}
        <span className="text-[var(--bone)]">calls a handful of functions instead of becoming a payment company.</span>
      </p>
    </section>
  );
}
