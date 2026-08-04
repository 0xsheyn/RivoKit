"use client";

import { useState } from "react";

/**
 * Presentational only — the questions come from whoever renders it.
 *
 * It used to carry its own six questions and sit inside the proof section,
 * where every one of them had drifted into a second answer to something the
 * page already covered properly: the FX guarantee (§04), who triggers a payout
 * (§04), custody (§05.1), production readiness (§05.1 + §06), the fiat leg and
 * the ceiling (both stated on the ledger itself). Six duplicate answers in a
 * softer voice, directly above a table of hashes — which weakened the table.
 * The content moved to `Faq.tsx`, before the install CTA, and was rewritten to
 * ask only what nothing else on the page answers.
 */
export type QA = { q: string; a: string };

export default function Accordion({ items }: { items: readonly QA[] }) {
  // Everything closed on arrival. One panel open by default put a paragraph of
  // prose between the first question and the second, which reads as an answer
  // the page decided you wanted — and it is the eight QUESTIONS that are the
  // scannable thing here, not whichever one happens to sit first.
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="divide-y divide-[color:var(--ash)]/20 border-y border-[color:var(--ash)]/20">
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q} className="hover-step group">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full cursor-pointer items-center justify-between gap-4 px-1 py-5 text-left"
            >
              <span className="f-display text-[18px] text-[var(--bone)] sm:text-[20px]">{item.q}</span>
              {/* The sign slides a few pixels toward the question it belongs
                  to, so the whole row reads as one target rather than a label
                  with a control parked at the far end. */}
              <span className="f-mono shrink-0 text-[16px] text-[var(--sodium)] transition-transform duration-200 group-hover:-translate-x-1">
                {isOpen ? "−" : "+"}
              </span>
            </button>
            {isOpen && (
              // No max-width. It was capped at 3xl inside a 1440px section, so
              // an answer set seven or eight short lines against half a screen
              // of empty gutter — the panel looked broken rather than
              // measured. Full width instead: the same words in three or four
              // lines, ending where the rules above and below them end.
              // Slightly larger, and the leading opened up, because a long
              // measure needs the extra line spacing to stay trackable.
              <p className="px-1 pb-6 text-[15px] leading-[1.75] text-[var(--bone)]/75 sm:text-[16px]">{item.a}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
