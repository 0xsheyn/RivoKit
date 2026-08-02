import { RiLoader4Line } from "@remixicon/react";

/**
 * Shown while the App Router fetches the next route.
 *
 * Without a `loading.tsx` a navigation holds the OLD page on screen with no
 * signal at all, which reads as a click that did nothing — the same complaint
 * the toasts fix for actions, at the routing layer.
 */
export default function Loading() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <RiLoader4Line className="size-4 animate-spin" />
      Loading…
    </main>
  );
}
