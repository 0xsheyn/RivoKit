"use client";

import { useState } from "react";

const COMMAND = "npm install github:0xsheyn/RivoKit";

export default function CopyInstall() {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-4 rounded-sm bg-[var(--ink-raised)] px-5 py-4">
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
        className="f-mono shrink-0 rounded-sm border border-[color:var(--ash)]/30 px-3 py-1.5 text-[12px] text-[var(--bone)] hover-step"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
