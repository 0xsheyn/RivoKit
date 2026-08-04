"use client";

import { useState } from "react";

const COMMAND = "npm install github:0xsheyn/RivoKit";

export default function CopyInstall() {
  const [copied, setCopied] = useState(false);

  return (
    // This box was `--ink-raised`, and so is the section it sits in — the same
    // fill, with no border between them. The field was not subtle, it was
    // invisible: the command read as loose text floating in the panel.
    //
    // It is RECESSED now rather than raised again. `--ink` is the page's base
    // fill, so on a raised panel it reads as a well cut into the surface, which
    // is what a terminal line is. The border does the rest of the work and is
    // what keeps this legible if the component is ever dropped onto `--ink`
    // itself, where the fills would collide the other way around. Its weight
    // matches the Copy button's, so the two edges belong to one control.
    <div className="flex items-center justify-between gap-4 rounded-sm border border-[color:var(--ash)]/30 bg-[var(--ink)] px-5 py-4">
      <code className="f-mono overflow-x-auto whitespace-nowrap text-[14px] text-[var(--bone)] sm:text-[15px]">
        {COMMAND}
      </code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(COMMAND);
          } catch {
            const scrollPos = window.scrollY;
            const textarea = document.createElement("textarea");
            textarea.value = COMMAND;
            textarea.style.position = "fixed";
            textarea.style.top = "0";
            textarea.style.left = "0";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.focus({ preventScroll: true });
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            window.scrollTo(0, scrollPos);
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="f-mono btn-outline shrink-0 rounded-sm border border-[color:var(--ash)]/30 px-3 py-1.5 text-[12px] text-[var(--bone)]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
