import { LIFECYCLE, type LifecycleState } from "@/lib/lifecycle";

/**
 * The colored flag.
 *
 * Colour is never the only signal. Every flag carries a word as well, because
 * roughly one man in twelve cannot reliably separate the amber from the red,
 * and "how long do I have on this account" is not a question to answer with hue
 * alone. The days remaining are shown as a number for the same reason.
 */
export function LifecycleFlag({
  state,
  daysLeft,
  className = "",
}: {
  state: LifecycleState;
  daysLeft?: number | null;
  className?: string;
}) {
  const presentation = LIFECYCLE[state] ?? LIFECYCLE.fresh;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${presentation.className} ${className}`}
      title={presentation.meaning}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {presentation.label}
      {typeof daysLeft === "number" && state !== "available" ? (
        <span className="tabular-nums opacity-75">{formatDays(daysLeft)}</span>
      ) : null}
    </span>
  );
}

function formatDays(days: number): string {
  if (days < 0) return `${Math.abs(days)}d over`;
  if (days === 0) return "today";
  return `${days}d left`;
}

/** The one-line explanation, for the detail page. */
export function LifecycleExplanation({
  state,
  daysLeft,
}: {
  state: LifecycleState;
  daysLeft?: number | null;
}) {
  const presentation = LIFECYCLE[state] ?? LIFECYCLE.fresh;
  const suffix =
    state === "available" || typeof daysLeft !== "number"
      ? ""
      : daysLeft < 0
        ? ` Returns to the pool at the next nightly sweep.`
        : ` ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`;
  return <span className="text-sm text-muted-foreground">{presentation.meaning}{suffix}</span>;
}
