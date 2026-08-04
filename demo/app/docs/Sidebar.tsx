"use client";

import { useEffect, useState } from "react";

import { DOC_SECTIONS } from "./sections";

/**
 * Tracks which section is being read. The observer's root is squeezed to a band
 * just under the sticky bar (`-116px` from the top, `-62%` from the bottom) so
 * "active" means "at the top of the viewport", not "somewhere on screen" —
 * without that band, three sections intersect at once on a tall display and the
 * highlight picks whichever fired last.
 *
 * The two ends the band cannot answer are handled outside it. A short last
 * section never reaches the band at all, so hitting the bottom of the document
 * pins the final entry; and before the first section scrolls up, nothing
 * intersects, which would leave the sidebar with no mark at all.
 */
function useActiveSection() {
  const [active, setActive] = useState<string>(DOC_SECTIONS[0].id);

  useEffect(() => {
    const sections = DOC_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (sections.length === 0) return;

    // Document order, not observer-callback order: entries arrive in whatever
    // order the browser produced them, and "the one nearest the top" is the
    // only reading that matches what the eye sees.
    const rank = new Map(sections.map((el, i) => [el.id, i]));
    const visible = new Set<string>();
    // The last section that is actually in the document, not the last one in
    // the list — those differ the moment a section is commented out.
    const lastId = sections[sections.length - 1]?.id;

    const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 2;

    const resolve = () => {
      if (lastId && atBottom()) {
        setActive(lastId);
        return;
      }
      if (visible.size === 0) return; // keep the last answer rather than blanking
      let best = "";
      for (const id of visible) {
        if (best === "" || (rank.get(id) ?? 0) < (rank.get(best) ?? 0)) best = id;
      }
      setActive(best);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        resolve();
      },
      { rootMargin: "-116px 0px -62% 0px" },
    );
    sections.forEach((el) => observer.observe(el));

    // The observer says nothing while the page is merely scrolled to its end,
    // which is exactly when the last section needs to be marked.
    window.addEventListener("scroll", resolve, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", resolve);
    };
  }, []);

  return active;
}

/**
 * The sticky rail on wide screens. Below `lg` it renders nothing — a sidebar
 * with nowhere to sit becomes a stack of links between the reader and the first
 * paragraph, so narrow screens get the wrapped row in the page header instead.
 */
export default function DocsSidebar() {
  const active = useActiveSection();

  return (
    <nav
      aria-label="On this page"
      // top-[116px]: the bar is 100px at md and up, plus the 16px of air the
      // page keeps under it everywhere else.
      // max-h/overflow: eight entries fit any laptop, but a browser at 200% zoom
      // is a viewport 300px tall, and a rail that cannot scroll simply loses its
      // last items.
      // mt-14 rather than pt-14: it lines the rail's eyebrow up with the page
      // header's while the rail is still in flow, and margin is not carried
      // into the stuck position — padding would push the whole list 56px down
      // the moment it stuck.
      className="sticky top-[116px] mt-14 hidden max-h-[calc(100svh-140px)] self-start overflow-y-auto [scrollbar-width:none] lg:block [&::-webkit-scrollbar]:hidden"
    >
      <p className="eyebrow mb-4">ON THIS PAGE</p>
      {/* The rule is the nav's, not each link's: one continuous hairline down
          the rail, with the active item's own border painted over it. That is
          why the items pull themselves back by a pixel. */}
      <ul className="flex flex-col border-l border-[color:var(--ash)]/20">
        {DOC_SECTIONS.map((s) => {
          const isActive = s.id === active;
          return (
            <li key={s.id} className="-ml-px">
              <a
                href={`#${s.id}`}
                aria-current={isActive ? "true" : undefined}
                // Deliberately not `.link-step`: that rule is `.rivo-landing
                // .link-step`, which out-specifies Tailwind's transition and
                // would leave the text fading while the marker snapped. One
                // transition covering both colour and border-color instead, so
                // the mark moves as one thing.
                className={`flex items-baseline gap-2 border-l-2 py-2 pl-4 text-[13px] leading-snug transition-colors duration-150 ease-out hover:text-[var(--bone)] ${
                  isActive
                    ? "border-[color:var(--sodium)] text-[var(--bone)]"
                    : "border-transparent text-[var(--bone)]/55"
                }`}
              >
                <span
                  className={`f-mono shrink-0 text-[11px] transition-colors duration-150 ease-out ${
                    isActive ? "text-[var(--sodium)]" : "text-[var(--ash)]"
                  }`}
                >
                  {s.number}
                </span>
                {s.label}
              </a>
            </li>
          );
        })}
      </ul>

      <a
        href="#top"
        className="link-step f-mono mt-6 inline-block pl-4 text-[11px] uppercase tracking-[0.16em] text-[var(--ash)]"
      >
        ↑ Top
      </a>
    </nav>
  );
}
