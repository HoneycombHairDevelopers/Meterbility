"use client";

import { useEffect, useRef } from "react";

export default function Reveal({
  children,
  as: Tag = "div",
  className = "",
}: {
  children: React.ReactNode;
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 }
    );
    io.observe(el);
    // Safety net: content must never stay hidden if the observer doesn't fire
    // (full-page capture, rendering crawlers, odd embedders).
    const failsafe = setTimeout(() => el.classList.add("is-in"), 1200);
    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, []);

  const Component = Tag as React.ElementType;
  return (
    <Component ref={ref} className={`reveal ${className}`.trim()}>
      {children}
    </Component>
  );
}
