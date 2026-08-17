"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { DEFINITIONS, type DefinitionKey } from "@/lib/definitions";

/**
 * The little "i" beside everything.
 *
 * Adoption is the whole reason this exists. A CRM with a rule as unforgiving as
 * a thirty-day clock loses people at the point where a number does not match
 * what they expected, and the usual outcome is not a support ticket -- it is
 * quietly deciding the system is wrong and working around it. An explanation
 * within reach of the cursor, at the moment of the doubt, is worth more than
 * any amount of training.
 *
 * Definitions live in one registry rather than as props at each call site, so
 * the same metric cannot end up explained two different ways on two screens.
 *
 * Opens on hover AND on focus AND on click: hover alone is unreachable by
 * keyboard and invisible on a touchscreen, and this is precisely the content a
 * new user needs most.
 */
export function InfoTip({
  k,
  text,
  className = "",
  side = "top",
}: {
  /** A key from the definitions registry. */
  k?: DefinitionKey;
  /** Or literal text, for one-off explanations that do not belong in the registry. */
  text?: string;
  className?: string;
  side?: "top" | "bottom" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  const definition = k ? DEFINITIONS[k] : undefined;
  const title = definition?.title;
  const body = text ?? definition?.body ?? "";
  const formula = definition?.formula;

  useEffect(() => {
    if (!pinned) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setPinned(false);
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  if (!body) return null;

  const position =
    side === "bottom"
      ? "top-full mt-1.5 left-1/2 -translate-x-1/2"
      : side === "right"
        ? "left-full ml-1.5 top-1/2 -translate-y-1/2"
        : "bottom-full mb-1.5 left-1/2 -translate-x-1/2";

  return (
    <span ref={ref} className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label={title ? `What is ${title}?` : "What is this?"}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => !pinned && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => !pinned && setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
          setOpen(true);
        }}
        className="text-muted-foreground/55 transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
      >
        <Info className="size-3.5" aria-hidden />
      </button>

      {open ? (
        <span
          id={id}
          role="tooltip"
          className={`absolute ${position} z-50 w-64 rounded-lg border bg-popover p-3 text-left shadow-xl`}
        >
          {title ? (
            <span className="block text-xs font-semibold text-foreground">{title}</span>
          ) : null}
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{body}</span>
          {formula ? (
            <span className="mt-2 block rounded bg-muted px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground">
              {formula}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** A heading with its explanation attached. Saves repeating the pair everywhere. */
export function LabelWithInfo({
  children,
  k,
  text,
  className = "",
}: {
  children: React.ReactNode;
  k?: DefinitionKey;
  text?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {children}
      <InfoTip k={k} text={text} />
    </span>
  );
}
