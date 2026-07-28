"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Fires once when the wrapped element first crosses the viewport, then
 * disconnects. Used to trigger the rail draw-in and the order-state "stamp" —
 * both are one-shot per RIVO_LP.md §7 ("Empat momen. Tidak ada kelima").
 */
export default function InView({
  children,
  className,
  activeClassName = "is-in-view",
  threshold = 0.35,
}: {
  children: ReactNode;
  className?: string;
  activeClassName?: string;
  threshold?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setActive(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return (
    <div ref={ref} className={`${className ?? ""} ${active ? activeClassName : ""}`.trim()}>
      {children}
    </div>
  );
}
