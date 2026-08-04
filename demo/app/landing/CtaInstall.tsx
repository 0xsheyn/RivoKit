import CopyInstall from "./CopyInstall";

export default function CtaInstall() {
  // "Get the SDK" in the topbar targets this section's id, so it needs the same
  // sticky-bar offset every other anchored section carries — 36px warning strip
  // + 56px bar, 64 from md.
  return (
    <section
      id="install"
      className="scroll-mt-[92px] bg-[var(--ink-raised)] px-5 py-12 md:scroll-mt-[100px] md:px-16"
    >
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="f-display text-[34px] text-[var(--bone)] sm:text-[52px]">Ready to settle in one call?</h2>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-[var(--bone)]/75">
          Clone it, run 441 tests with no credentials at all, deploy the escrow to Arc testnet, and clear a full order
          from multi-chain USDC to a bank payout.
        </p>

        <div className="mt-8">
          <CopyInstall />
        </div>
        <p className="eyebrow mt-3">PACKAGE IS PRIVATE — INSTALLED STRAIGHT FROM GIT, NEVER THE NPM REGISTRY.</p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href="https://github.com/0xsheyn/RivoKit#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-solid rounded-sm bg-[var(--sodium)] px-5 py-2.5 text-sm font-medium text-[var(--ink)]"
          >
            Read the README
          </a>
          <a
            href="https://github.com/0xsheyn/RivoKit"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-outline rounded-sm border border-[color:var(--ash)]/40 px-5 py-2.5 text-sm text-[var(--bone)]"
          >
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
