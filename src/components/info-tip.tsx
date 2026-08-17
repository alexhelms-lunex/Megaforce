"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { DEFINITIONS, type DefinitionKey } from "@/lib/definitions";

/**
 * The little "i" beside everything.
 *
 * ---------------------------------------------------------------------------
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
 * ---------------------------------------------------------------------------
 * WHY THE PANEL IS A PORTAL AND NOT AN ABSOLUTELY POSITIONED CHILD
 *
 * The first version placed the panel `absolute` inside the icon's own wrapper.
 * That works only when nothing between the icon and the page root clips or
 * transforms, and in this application almost everything does: stat cards carry
 * `overflow-hidden` for their rounded corners, tables scroll horizontally
 * inside `overflow-x-auto`, and the docks are fixed panels with their own
 * stacking context. The result was tooltips sliced off at a card edge or
 * hidden behind a table -- which read, correctly, as "none of the info tabs
 * work".
 *
 * A portal to <body> leaves every ancestor behind: no clipping, no inherited
 * `uppercase` from a label, no z-index race with a sticky header. The cost is
 * having to place it by hand from the trigger's bounding box, which is the
 * cheaper half of the trade.
 *
 * Opens on hover AND on focus AND on click: hover alone is unreachable by
 * keyboard and invisible on a touchscreen, and this is precisely the content a
 * new user needs most.
 * ---------------------------------------------------------------------------
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
  /** Preferred placement. Flips automatically when there is no room. */
  side?: "top" | "bottom" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const definition = k ? DEFINITIONS[k] : undefined;
  const title = definition?.title;
  const body = text ?? definition?.body ?? "";
  const formula = definition?.formula;

  const WIDTH = 288; // w-72, fixed so placement can be computed before paint.
  const GAP = 8;

  /**
   * Put the panel where it fits.
   *
   * Measured against the viewport rather than the document because the panel is
   * `position: fixed`. Preferred side first; if the panel would leave the
   * viewport it flips, and it is clamped horizontally either way so a tooltip
   * on a metric at the right edge of the screen is still fully readable.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 140;

    let top: number;
    let left: number;

    if (side === "right") {
      top = r.top + r.height / 2 - height / 2;
      left = r.right + GAP;
      if (left + WIDTH > window.innerWidth - 8) left = r.left - WIDTH - GAP;
    } else {
      const above = side === "top";
      const roomAbove = r.top > height + GAP + 8;
      const roomBelow = window.innerHeight - r.bottom > height + GAP + 8;
      const goAbove = above ? roomAbove || !roomBelow : !roomBelow && roomAbove;
      top = goAbove ? r.top - height - GAP : r.bottom + GAP;
      left = r.left + r.width / 2 - WIDTH / 2;
    }

    // Clamp inside the viewport with an 8px margin, so nothing is ever cut off.
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - WIDTH - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));

    setBox({ top, left });
  }, [side]);

  // Layout effect, not effect: placing after paint makes the panel visibly jump
  // from the corner of the screen to its resting position on every open.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    function onScrollOrResize() {
      place();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setPinned(false);
        setOpen(false);
      }
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setPinned(false);
      setOpen(false);
    }

    // `true` for capture: a scroll inside a table or a dock does not bubble to
    // window, and a panel left behind by a scrolled trigger is worse than none.
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place]);

  if (!body) return null;

  const panel =
    open && box !== null && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            style={{ top: box.top, left: box.left, width: WIDTH }}
            // Every inheritable text property is restated. The panel is a child
            // of <body> so nothing SHOULD reach it, but these also stop a future
            // global rule on body from turning explanations into small caps --
            // which is the exact defect this component shipped with.
            className="pointer-events-auto fixed z-[100] rounded-lg border border-border bg-popover p-3 text-left font-sans text-xs font-normal normal-case leading-relaxed tracking-normal text-popover-foreground shadow-2xl"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => !pinned && setOpen(false)}
          >
            {title ? (
              <p className="text-xs font-semibold normal-case text-foreground">{title}</p>
            ) : null}
            <p className="mt-1 text-xs font-normal normal-case leading-relaxed text-muted-foreground">
              {body}
            </p>
            {formula ? (
              <p className="mt-2 rounded bg-muted px-2 py-1 font-mono text-[11px] font-normal normal-case leading-relaxed tracking-normal text-foreground">
                {formula}
              </p>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={title ? `What is ${title}?` : "What is this?"}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => !pinned && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => !pinned && setOpen(false)}
        onClick={(e) => {
          // Both, and deliberately. These icons sit inside links and inside
          // table rows that navigate; without this, asking what a column means
          // takes you to another screen.
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
          setOpen(true);
        }}
        className={`inline-flex shrink-0 align-middle text-muted-foreground/60 transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none ${className}`}
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      {panel}
    </>
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
