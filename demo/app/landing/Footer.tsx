import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_RPC_URL,
  CIRCLE_FAUCET_URL,
} from "../../../src/constants/arc";

/**
 * WHERE TO GO, NOT WHERE YOU HAVE BEEN
 *
 * This column used to be the topbar's `NAV` array, imported so the two could
 * not drift. That was the right instinct applied to the wrong list: `NAV` is
 * five fragments of THIS page, and the topbar is sticky — it carries them the
 * whole way down and is still on screen when you reach the bottom. Repeating
 * them here spends the last row of the document telling a reader about the one
 * place they have just finished being.
 *
 * So this is a list of destinations instead — the routes and the external
 * things a reader wants once the page is over. Nothing is duplicated, which is
 * why nothing has to be kept in step.
 */
const SERVICE = [
  { label: "Main", href: "/" },
  { label: "Demo", href: "/app" },
  { label: "Docs", href: "/docs" },
  { label: "Contracts", href: `${ARC_TESTNET_EXPLORER_URL}/address/0x6bfd1895d519d2ec936038824b8c7ab4ff700253` },
  { label: "Faucet", href: CIRCLE_FAUCET_URL },
] as const;

/**
 * The builder's accounts, as words.
 *
 * They were four icons on one line, which is the right call in a dense bar and
 * the wrong one here: this footer has a column for them, and a column of glyphs
 * is a column of small targets that all look alike. Named, they read at the
 * same size as the routes beside them and need no tooltip to be understood.
 */
const SOCIAL = [
  { label: "Twitter", href: "https://x.com/agquais" },
  { label: "Discord", href: "https://discord.com/users/393224117371011082" },
  { label: "GitHub", href: "https://github.com/0xsheyn/RivoKit" },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/yaziedbachtiar/" },
] as const;

/** Chain facts, each under its own label. Read, not clicked. */
const CHAIN = [
  { label: "Chain", value: `Arc Testnet · ${ARC_TESTNET_CHAIN_ID}` },
  { label: "RPC URL", value: ARC_TESTNET_RPC_URL },
  { label: "Explorer", value: `${ARC_TESTNET_EXPLORER_URL}/` },
] as const;

/** A group heading: sodium, mono, uppercase — the page's own label vocabulary. */
function ColumnLabel({ children }: { children: React.ReactNode }) {
  return (
    // `eyebrow` sets `color: var(--ash)` at specificity (0,2,0), which beats a
    // Tailwind colour utility at (0,1,0) — the same trap the topbar's warning
    // strip fell into. So the class is spelled out rather than used.
    <p className="f-mono mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--sodium)]">
      {children}
    </p>
  );
}

function ColumnLink({ href, children }: { href: string; children: React.ReactNode }) {
  // Same-origin routes navigate in place; everything else opens away. Decided
  // from the href rather than from a flag, so a link added later cannot get the
  // pair wrong.
  const external = !href.startsWith("/");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="f-display link-step block py-1 text-[16px] text-[var(--bone)]/75"
    >
      {children}
    </a>
  );
}

export default function Footer() {
  return (
    <footer className="relative overflow-hidden px-5 pt-16 md:px-16">
      {/*
       * The wordmark and the columns share one row from `lg` up, and the
       * wordmark takes the space nothing else wants. Below that they stack —
       * a 200px logotype and a four-column link grid do not both fit on a
       * phone, and shrinking the type until they do is how a signature becomes
       * a graphic.
       */}
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_auto]">
        {/*
         * The signature. It was centred and clipped at the page's bottom edge,
         * which made it a full-bleed ornament; here it is a mark with something
         * beside it, so it sits where a signature sits — bottom left, with the
         * one line that says what the thing IS underneath it.
         *
         * `aria-hidden` on the wordmark, not on the line below: the name is
         * already in the topbar and the title, so repeating it to a screen
         * reader at 200px adds nothing. The tagline is not decoration.
         */}
        <div className="min-w-0 self-end">
          <p
            aria-hidden
            className="f-display pointer-events-none -ml-1 select-none leading-[0.78] text-[var(--bone)]/[0.07]"
            style={{ fontSize: "clamp(72px, 13vw, 190px)" }}
          >
            rivokit
          </p>
          {/*
           * Mono, and this is the one place on the page where mono is NOT
           * carrying a number. It is carrying a definition — the sentence a
           * reader repeats to someone else — and mono is what makes it read as
           * a stated fact rather than as marketing beneath a logo.
           */}
          <p className="f-mono mt-6 text-[13px] leading-relaxed text-[var(--bone)]/60">
            An embeddable cross-border settlement SDK on Arc
          </p>
        </div>

        {/* `auto-cols` rather than a fixed three: the chain block is wider than
            the two link columns and should keep its URLs on one line. */}
        <div className="grid grid-cols-2 gap-x-10 gap-y-10 sm:grid-cols-[auto_auto_auto] sm:gap-x-14 lg:gap-x-20">
          <nav aria-label="Service">
            <ColumnLabel>Service</ColumnLabel>
            {SERVICE.map((item) => (
              <ColumnLink key={item.href} href={item.href}>{item.label}</ColumnLink>
            ))}
          </nav>

          <nav aria-label="Social">
            <ColumnLabel>Social</ColumnLabel>
            {SOCIAL.map((item) => (
              <ColumnLink key={item.href} href={item.href}>{item.label}</ColumnLink>
            ))}
          </nav>

          {/* Three labelled facts stacked, not a fourth link column — none of
              these is a destination, and styling them as links would offer a
              click that goes nowhere. */}
          <div className="col-span-2 min-w-0 space-y-5 sm:col-span-1">
            {CHAIN.map(({ label, value }) => (
              <div key={label} className="min-w-0">
                <ColumnLabel>{label}</ColumnLabel>
                {/* -mt-2: `ColumnLabel` carries mb-3 for a list of links, which
                    is too much air above a single value. */}
                <p className="f-display -mt-2 truncate text-[16px] text-[var(--bone)]/75">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/*
       * The legal line and the proof line, at opposite ends of the last row.
       *
       * They belong together and they are not the same kind of statement: the
       * left one is what this software is, the right one is the exact limit of
       * what was observed. Putting them on one rule keeps the page from ending
       * on a claim without its qualifier — and keeps the qualifier from looking
       * like a footnote nobody reads.
       */}
      <div className="mx-auto mt-16 flex max-w-[1440px] flex-col gap-2 border-t border-[color:var(--ash)]/20 py-6 text-center sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:text-left">
        <p className="f-mono text-[11px] uppercase tracking-[0.14em] text-[var(--ash)]">
          Testnet-stage sample software — not a licensed financial product
        </p>
        <p className="f-mono text-[11px] uppercase tracking-[0.14em] text-[var(--ash)]">
          CPN reported completed — not a bank statement
        </p>
      </div>
    </footer>
  );
}
