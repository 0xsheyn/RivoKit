/**
 * The five links worth a permanent slot, and the one action. The footer imports
 * this same array rather than keeping its own copy — a second list is a second
 * thing to forget when a section is renamed.
 */
export const NAV = [
  // Rooted at "/" rather than bare fragments so the same bar works on /docs.
  // On the landing page itself the browser still treats these as same-document
  // fragment navigation — no reload.
  { href: "/#problem", label: "Problem" },
  { href: "/#capabilities", label: "What it does" },
  { href: "/#proof", label: "Proof" },
  { href: "/#roadmap", label: "Roadmap" },
  { href: "/docs", label: "Docs" },
] as const;

export default function Topbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-[color:var(--ash)]/20 bg-[color:var(--ink)]/85 backdrop-blur-md">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-5 md:h-16 md:px-16"
      >
        <a href="/#top" className="f-display shrink-0 text-[19px] leading-none text-[var(--bone)] md:text-[21px]">
          rivokit
        </a>

        {/* A scrolling row rather than a hamburger: five short labels fit across
            most phones, and the ones that don't scroll — no JS, no open state,
            and the nav stays a server component. */}
        <div className="-mx-1 flex min-w-0 flex-1 items-center gap-x-5 overflow-x-auto px-1 [scrollbar-width:none] md:gap-x-7 [&::-webkit-scrollbar]:hidden">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="link-step f-mono whitespace-nowrap text-[12px] uppercase tracking-[0.08em] text-[var(--bone)]/70 md:text-[13px]"
            >
              {item.label}
            </a>
          ))}
        </div>

        <a
          href="/#install"
          className="btn-solid f-mono shrink-0 rounded-sm bg-[var(--sodium)] px-3 py-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink)] md:px-4 md:text-[13px]"
        >
          Install
        </a>
      </nav>
    </header>
  );
}
