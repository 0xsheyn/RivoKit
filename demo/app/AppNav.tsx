"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { RiHandCoinLine, RiStore2Line } from "@remixicon/react";
import { Button } from "@/components/ui/button";

/**
 * The two halves of the demo. Kept as real routes rather than tabs so the
 * withdraw page carries none of the marketplace's polling, and either half can
 * be linked to directly.
 *
 * The icons are deliberately not the ones the panels below already use for a
 * bank or a wallet: this nav points at two halves of the demo, not at two rails.
 */
const LINKS = [
  { href: "/app", label: "Market Demo", Icon: RiStore2Line },
  { href: "/app/withdraw", label: "Withdraw", Icon: RiHandCoinLine },
] as const;

export default function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
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
