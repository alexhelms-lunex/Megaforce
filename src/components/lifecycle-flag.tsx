import { LIFECYCLE, type LifecycleState } from "@/lib/lifecycle";
import { InfoTip } from "@/components/info-tip";

/**
 * The status flag.
 *
 * ---------------------------------------------------------------------------
 * Colour is never the only signal. Every flag carries a word as well, because
 * roughly one man in twelve cannot reliably separate the amber from the red,
 * and "how long do I have on this account" is not a question to answer with hue
 * alone. The days remaining are a number for the same reason, and the meter
 * below encodes the same fact a third way, as length.
 *
 * Three encodings of one value sounds like too much. It is not: this is the
 * single number that decides whether somebody keeps an account, it is read at a
 * glance while scanning eighty rows, and being wrong about it costs a
 * commission.
 * ---------------------------------------------------------------------------
 */
export function LifecycleFlag({
  state,
  daysLeft,
  className = "",
  showMeter = false,
  /** Total days in the window, so the meter knows what fraction is used. */
  windowDays = 45,
}: {
  state: LifecycleState;
  daysLeft?: number | null;
  className?: string;
  showMeter?: boolean;
  windowDays?: number;
}) {
  const presentation = LIFECYCLE[state] ?? LIFECYCLE.fresh;

  const pill = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${presentation.className} ${className}`}
      title={presentation.meaning}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${presentation.dotClassName}`} />
      {presentation.label}
      {typeof daysLeft === "number" && state !== "available" ? (
        <span className="tabular-nums font-normal opacity-80">{formatDays(daysLeft)}</span>
      ) : null}
    </span>
  );

  if (!showMeter || typeof daysLeft !== "number" || state === "available") return pill;

  // How much of the window has been used. Clamped, because an overdue account
  // is past 100% and a bar that overflows its track looks like a rendering bug
  // rather than the emergency it is.
  const used = Math.min(100, Math.max(0, ((windowDays - daysLeft) / windowDays) * 100));

  return (
    <span className="inline-flex flex-col items-end gap-1">
      {pill}
      <span
        aria-hidden
        className="h-1 w-20 overflow-hidden rounded-full bg-muted"
        title={`${Math.round(used)}% of the window used`}
      >
        <span
          className={`block h-full rounded-full ${presentation.meterClassName}`}
          style={{ width: `${Math.max(used, 3)}%` }}
        />
      </span>
    </span>
  );
}

/**
 * The coloured edge on a table row.
 *
 * Colour moved off the badge and onto the row itself. Scanning a list, the eye
 * follows the left margin, so a stripe there is read before any text is —
 * urgency becomes a shape in peripheral vision rather than something you have
 * to look across the row to find.
 */
export function lifecycleRowAccent(state: LifecycleState): string {
  return (LIFECYCLE[state] ?? LIFECYCLE.fresh).rowClassName;
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
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <span>
        {presentation.meaning}
        {suffix}
      </span>
      <InfoTip k="clock" />
    </span>
  );
}
