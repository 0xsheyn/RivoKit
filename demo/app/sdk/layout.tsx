import { DemoFooter, DemoHeader, TOPBAR_VARS } from "../DemoShell";

/**
 * `/sdk` wears the same chrome as `/app`. It had none until now: the page was
 * linked FROM the demo header and led nowhere back, so the only way out was the
 * browser's own back button.
 *
 * No board and no `calc` here — the page is an ordinary document that scrolls —
 * but `--topbar` is still declared, because the shared header sizes itself from
 * it.
 */
export default function SdkLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`flex min-h-screen flex-col bg-muted/30 ${TOPBAR_VARS}`}>
      <DemoHeader />
      <div className="flex-1">{children}</div>
      <DemoFooter />
    </div>
  );
}
