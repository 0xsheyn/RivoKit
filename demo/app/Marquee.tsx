/**
 * The "what is real / what is mocked" line, scrolling under the topbar. Two
 * copies of the same children ride the track so the loop is seamless; the
 * second is `aria-hidden` so a screen reader hears the sentence once.
 */
export default function Marquee({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 overflow-hidden border-b bg-background py-1.5">
      {/* The spacing between copies is the copy's own trailing padding, not a
          track gap: -50% of a gapped track lands half a gap short and stutters. */}
      <div className="rivo-marquee flex w-max items-center whitespace-nowrap text-xs text-muted-foreground">
        <span className="shrink-0 pr-24">{children}</span>
        <span aria-hidden className="shrink-0 pr-24">{children}</span>
      </div>
    </div>
  );
}
