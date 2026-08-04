import {
  RiDiscordFill,
  RiGithubFill,
  RiLinkedinFill,
  RiTwitterXFill,
} from "@remixicon/react";
import { NAV } from "./Topbar";

/**
 * The builder's accounts. Icon-only: four wordmarks on the closing line of the
 * page would compete with the chain id beside them, and these particular marks
 * are recognised without their names. The name still travels — as `aria-label`
 * and as the native tooltip — so the row is not a puzzle to anyone reading it
 * with a screen reader or hovering to check where a link goes.
 */
const SOCIALS = [
  { label: "X (Twitter)", href: "https://x.com/agquais", Icon: RiTwitterXFill },
  { label: "GitHub", href: "https://github.com/0xsheyn/", Icon: RiGithubFill },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/yaziedbachtiar/", Icon: RiLinkedinFill },
  { label: "Discord", href: "https://discord.com/users/393224117371011082", Icon: RiDiscordFill },
] as const;

export default function Footer() {
  return (
    <footer className="relative overflow-hidden px-5 pt-12 md:px-16">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 border-b border-[color:var(--ash)]/20 pb-8 text-[13px] text-[var(--bone)]/70">
        {/* The topbar's list, imported rather than retyped — see Topbar.tsx. The
            explorer link is the one addition: it leaves the page entirely, which
            is why the topbar does not carry it.

            Serif italic, matching the bar at the other end of the page: the
            same five links should not change face depending on which end of the
            scroll you read them at. They were mono, which reads as data — and a
            nav link is not data. The mono in this footer is now only on the
            line that IS data, the chain id below. */}
        <div className="f-display flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="link-step">
              {item.label}
            </a>
          ))}
          <a
            href="https://testnet.arcscan.app/address/0x6bfd1895d519d2ec936038824b8c7ab4ff700253"
            target="_blank"
            rel="noopener noreferrer"
            className="link-step"
          >
            Contracts (arcscan)
          </a>
        </div>
        <p className="eyebrow">Testnet-stage sample software — not a licensed financial product.</p>
      </div>

      {/* The chain id and the accounts share this line: the disclaimer above
          ends the legal reading of the page, and what follows is who built it
          and what it ran on. `flex-wrap` lets the icons drop below the id on a
          narrow screen rather than crushing a line that must stay readable. */}
      <div className="mx-auto mt-6 flex max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {/* "ROUTE CLOSED · CPN COMPLETED" read as money landing. The route that
            closed is the on-chain one, which is the half anyone can verify. */}
        <p className="f-mono min-w-0 text-[11px] text-[var(--verdigris)]">
          ARC TESTNET · CHAIN 5042002 ·{" "}
          <span className="text-[var(--ash)]">CPN REPORTED COMPLETED — NOT A BANK STATEMENT</span>
        </p>

        <ul className="flex shrink-0 items-center gap-1">
          {SOCIALS.map(({ label, href, Icon }) => (
            <li key={href}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer me"
                aria-label={label}
                title={label}
                // The hit area is the padding, not the glyph: a 16px icon is
                // below the ~24px a finger can reliably land on, and this row
                // sits at the very bottom of a long page where a miss means
                // scrolling back.
                className="flex items-center justify-center rounded-sm p-2 text-[var(--bone)]/60 transition-colors hover:text-[var(--bone)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sodium)]"
              >
                <Icon className="size-4" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      </div>

      <p
        aria-hidden
        className="f-display pointer-events-none mt-6 select-none text-center leading-none text-[var(--bone)]/10"
        style={{ fontSize: "clamp(96px, 24vw, 320px)", transform: "translateY(18%)" }}
      >
        rivokit
      </p>
    </footer>
  );
}
