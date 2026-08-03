/**
 * The closing line of PROOFS.md, given the position it deserves.
 *
 * A proof table is only worth its links if a reader can go and check it, so
 * this sits directly under the ledger with the commands that do exactly that.
 * Verbatim from PROOFS.md > Reproducing any of this — the `probe-*` scripts
 * fund nothing, which is what makes them safe to put on a public page.
 */
const COMMANDS = [
  { cmd: "node scripts/probe-cpn-status.mjs", note: "what CPN says right now" },
  { cmd: "node scripts/probe-cpn-source.mjs FR", note: "routes for one destination country" },
  { cmd: "node scripts/probe-cpn-lifecycle.mjs", note: "every state reachable without a broadcast" },
  { cmd: "node scripts/live-payout-reconcile.mjs", note: "settle any stale payout rows" },
];

export default function Reproduce() {
  return (
    <div className="mt-14">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3 border-b border-[color:var(--ash)]/20 pb-3">
        <span className="eyebrow">05.2 —— CHECK IT YOURSELF</span>
        <span className="eyebrow">probe-* SCRIPTS FUND NOTHING</span>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <div className="md:col-span-5">
          <h3 className="f-display text-[26px] leading-tight text-[var(--bone)] sm:text-[32px]">
            The claims above are meant to be falsifiable.
          </h3>
          <p className="mt-4 text-[14px] leading-relaxed text-[var(--bone)]/75">
            If a hash does not show what this page says it shows,{" "}
            <span className="text-[var(--bone)]">the page is wrong — and the page is what gets fixed.</span> Every
            transaction above opens on a public explorer without asking anyone&apos;s permission. The API-side claims
            need <span className="f-mono text-[var(--sodium)]">.env.local</span>, and anything that moves money is
            gated behind an explicit <span className="f-mono text-[var(--sodium)]">CONFIRM=</span> variable.
          </p>
        </div>

        <div className="md:col-span-7">
          <div className="divide-y divide-[color:var(--ash)]/15 overflow-hidden rounded-sm bg-[var(--ink-raised)]">
            {COMMANDS.map((c) => (
              <div key={c.cmd} className="hover-step group px-5 py-4">
                <p className="f-mono overflow-x-auto whitespace-nowrap text-[12.5px] text-[var(--bone)]">
                  {/* The prompt warms to sodium — a shell answering the cursor,
                      which is the joke these four rows are already making. */}
                  <span className="text-[var(--verdigris)] transition-colors group-hover:text-[var(--sodium)]">$ </span>
                  {c.cmd}
                </p>
                <p className="eyebrow mt-1.5">{c.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
