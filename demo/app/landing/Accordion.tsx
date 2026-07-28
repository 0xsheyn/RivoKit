"use client";

import { useState } from "react";

const QUESTIONS: Array<{ q: string; a: string }> = [
  {
    q: "Do you hold my money?",
    a: "No. Funds sit in the Commerce Payments Protocol escrow on Arc. The operator submits transactions and earns a fee; it cannot redirect funds. Deployer, operator, and merchant are three separate wallets.",
  },
  {
    q: "Is the FX rate actually guaranteed?",
    a: "The recipient gets ≥ €P or the swap reverts, funds safe. It's stopLimit = priceEUR enforced by the chain, not by application code.",
  },
  {
    q: "Is the fiat leg real, or a mock?",
    a: "EUR/SEPA is proven end-to-end to COMPLETED, twice (15 USDC → 12.92 EUR). BRL, MXN and USD are verified only as far as prepare — live requirements and quotes, no settlement yet. And the SDK's own payout module is still a labelled MOCK; the real exit is createCpnRamp. We won't blur that line.",
  },
  {
    q: "Who can trigger a payout?",
    a: "Only the host's release hook (a milestone, an SLA, access granted). Cashing out is the recipient's own later decision over an accumulated balance — deliberately not wired into release().",
  },
  {
    q: "Can I trust this in production?",
    a: "Not yet. Testnet/sandbox, unaudited. In production the host must be an onboarded OFI with KYB/AML. RivoKit is not a licensed operator and cannot be one for you.",
  },
];

export default function Accordion() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="divide-y divide-[color:var(--ash)]/20 border-y border-[color:var(--ash)]/20">
      {QUESTIONS.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q} className="hover-step">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-1 py-5 text-left"
            >
              <span className="f-display text-[18px] text-[var(--bone)] sm:text-[20px]">{item.q}</span>
              <span className="f-mono shrink-0 text-[16px] text-[var(--sodium)]">{isOpen ? "−" : "+"}</span>
            </button>
            {isOpen && (
              <p className="max-w-3xl px-1 pb-6 text-[14px] leading-relaxed text-[var(--bone)]/75 sm:text-[15px]">
                {item.a}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
