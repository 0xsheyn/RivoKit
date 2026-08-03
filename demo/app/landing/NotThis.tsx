/**
 * Four sentences from LIMITATIONS.md > What RivoKit is not.
 *
 * A subsection rather than a section: it belongs beside the proof table, and
 * giving it a numbered slot of its own would have cost more page than the
 * content is worth. The last one is the least obvious — holding no keys is a
 * constraint on what the SDK can do for you, not only a security property.
 */
const NOT = [
  {
    title: "Not a marketplace, wallet, custodian, or licensed institution.",
    body: "It orchestrates. The licensed host that embeds it stays the party of record — in production, an onboarded OFI with KYB/AML on recipients. RivoKit is not a licensed operator and cannot be one for you.",
  },
  {
    title: "It does not verify the physical world.",
    body: "The release hook is the host's judgement call. RivoKit checks consistency; it does not prove delivery.",
  },
  {
    title: "It writes no primitives from scratch, and no Solidity of its own.",
    body: "App Kit, the Commerce Payments Protocol and CPN, composed behind one API.",
  },
  {
    title: "It holds no keys.",
    body: "Every signer is injected — a constraint on what it can do for you, not only a security property. Deployer, operator and merchant are three separate wallets; the operator submits transactions and earns a fee, and cannot redirect funds.",
  },
];

export default function NotThis() {
  return (
    <div className="mt-14">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3 border-b border-[color:var(--ash)]/20 pb-3">
        <span className="eyebrow">05.1 —— WHAT RIVOKIT IS NOT</span>
        <span className="eyebrow">STATED SO ITS ABSENCE ISN&apos;T READ AS AN UNFINISHED EDGE</span>
      </div>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm bg-[color:var(--ash)]/15 sm:grid-cols-2">
        {NOT.map((n) => (
          <div key={n.title} className="hover-step hover-accent bg-[var(--ink-raised)] p-5">
            <p className="f-display text-[18px] leading-tight text-[var(--bone)]">{n.title}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--bone)]/70">{n.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
