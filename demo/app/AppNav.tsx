"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { RiBracesLine, RiHandCoinLine, RiStore2Line } from "@remixicon/react";
import { Button } from "@/components/ui/button";

/**
 * The three demo routes. Kept as real routes rather than tabs so the withdraw
 * page carries none of the marketplace's polling, and any of them can be linked
 * to directly.
 *
 * `/sdk` is here because it used to be reachable only one way — an outline
 * button in the header — and carried no way back once you arrived. A route in
 * the nav is a route you can leave.
 *
 * The icons are deliberately not the ones the panels below already use for a
 * bank or a wallet: this nav points at parts of the demo, not at rails.
 */
const LINKS = [
  { href: "/app", label: "Market Demo", Icon: RiStore2Line },
  { href: "/app/withdraw", label: "Withdraw", Icon: RiHandCoinLine },
  { href: "/sdk", label: "SDK surface", Icon: RiBracesLine },
] as const;

export default function AppNav() {
  const pathname = usePathname();
  return (
    // Three labelled buttons do not fit a 360px screen, and every Button here
    // carries `shrink-0` — so without somewhere to go the overflow lands on top
    // of its neighbour. It scrolls instead. Centring is left to the `sm` breakpoint
    // and up: a centred overflow container hides its own first item in some
    // browsers, which is the one case where the nav would silently lose a link.
    <nav className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] sm:justify-center [&::-webkit-scrollbar]:hidden">
      {LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Button
            key={l.href}
            size="sm"
            variant={active ? "secondary" : "ghost"}
            // These are links, not buttons. Base UI assumes a native <button>
            // unless told otherwise, and warns rather than silently dropping
            // the button semantics it can no longer provide.
            nativeButton={false}
            render={
              <Link href={l.href} aria-current={active ? "page" : undefined}>
                <l.Icon className="size-4" />
                {l.label}
              </Link>
            }
          />
        );
      })}
    </nav>
  );
}
