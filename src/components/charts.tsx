import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import type { DefinitionKey } from "@/lib/definitions";

/**
 * The dashboard's visual vocabulary.
 *
 * Drawn with CSS and inline SVG rather than a charting library. Three reasons:
 * these render on the server so the numbers are in the HTML rather than
 * appearing a beat later, they inherit the brand tokens instead of carrying
 * their own palette, and a 200KB library to draw fourteen rectangles is a bad
 * trade on a screen a thousand people open every morning.
 */

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  href,
  tone = "default",
  info,
}: {
  label: string;
  value: string | number;
  hint?: string;
  /** Percentage change against the comparison period. */
  delta?: number | null;
  icon?: LucideIcon;
  href?: string;
  tone?: "default" | "warning" | "danger" | "good";
  /** Explains exactly how this figure is arrived at. */
  info?: DefinitionKey;
}) {
  const toneRing =
    tone === "danger"
      ? "border-destructive/35"
      : tone === "warning"
        ? "border-amber-400/50"
        : tone === "good"
          ? "border-brand-400/50"
          : "";

  /**
   * Two things here are deliberate and were both bugs before.
   *
   * No `overflow-hidden`. It was there to keep the rounded corners tidy and it
   * sliced every tooltip opened from inside a card in half. The tooltip is a
   * portal now, so the clip would no longer bite -- but a card that silently
   * amputates anything overflowing it is a trap for the next thing added.
   *
   * The link is a stretched overlay rather than a wrapper. Wrapping put the
   * info button inside an anchor, which is invalid HTML and made "what does
   * this number mean" navigate away instead of answering. The overlay covers
   * the card for clicking, and the button sits one layer above it.
   */
  return (
    <div
      className={`group relative h-full rounded-lg border bg-card p-4 transition-shadow ${toneRing} ${
        href ? "hover:shadow-md" : ""
      }`}
    >
      {href ? (
        <Link
          href={href}
          aria-label={label}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {info ? (
            <span className="relative z-20 inline-flex">
              <InfoTip k={info} side="bottom" />
            </span>
          ) : null}
        </p>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden /> : null}
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {typeof delta === "number" ? <Delta value={delta} /> : null}
        {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {href ? (
        <ArrowRight
          className="absolute bottom-4 right-4 size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      ) : null}
    </div>
  );
}

/**
 * Direction against the previous period.
 *
 * Deliberately does not colour "up" green unconditionally -- the caller says
 * which direction is good. More calls is good; more accounts at risk is not,
 * and a green arrow on a rising risk number is worse than no arrow at all.
 */
function Delta({ value }: { value: number }) {
  if (!Number.isFinite(value) || Math.round(value) === 0) {
    return <span className="text-xs text-muted-foreground">flat vs last week</span>;
  }
  const up = value > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        up ? "text-brand-600" : "text-destructive"
      }`}
    >
      <Icon className="size-3.5" aria-hidden />
      {Math.abs(Math.round(value))}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// Daily bars
// ---------------------------------------------------------------------------

export interface DayBar {
  day: string;
  calls: number;
  qualifying: number;
}

/**
 * Calls per day, with the qualifying portion stacked inside.
 *
 * One bar, two segments, rather than two bars side by side: the question is
 * "how much of what I did counted", and that is a proportion, not a comparison.
 * The gap between the segments is the whole story of the prospecting policy.
 */
export function DailyBars({ data, className = "" }: { data: DayBar[]; className?: string }) {
  const max = Math.max(1, ...data.map((d) => d.calls));

  return (
    <div className={className}>
      <div className="flex h-32 items-end gap-1">
        {data.map((d) => {
          const total = (d.calls / max) * 100;
          const good = d.calls === 0 ? 0 : (d.qualifying / d.calls) * 100;
          return (
            <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className="relative w-full overflow-hidden rounded-t bg-navy-200 transition-colors group-hover:bg-navy-300 dark:bg-navy-800"
                style={{ height: `${Math.max(total, d.calls > 0 ? 4 : 2)}%` }}
              >
                <div
                  className="absolute inset-x-0 bottom-0 bg-brand-400"
                  style={{ height: `${good}%` }}
                />
              </div>
              {/* Native title rather than a JS tooltip: it works on the server,
                  it works with the keyboard, and it never needs hydrating. */}
              <span className="sr-only">
                {d.day}: {d.calls} calls, {d.qualifying} qualifying
              </span>
              <span
                aria-hidden
                title={`${d.day} — ${d.calls} calls, ${d.qualifying} qualifying`}
                className="absolute inset-0"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{shortDay(data[0]?.day)}</span>
        <span className="flex items-center gap-3">
          <Swatch className="bg-brand-400" label="counted" />
          <Swatch className="bg-navy-200 dark:bg-navy-800" label="didn’t count" />
        </span>
        <span>{shortDay(data[data.length - 1]?.day)}</span>
      </div>
    </div>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`size-2 rounded-sm ${className}`} aria-hidden />
      {label}
    </span>
  );
}

function shortDay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Ranked bars
// ---------------------------------------------------------------------------

export interface BarRow {
  label: string;
  value: number;
  /** Optional second figure, drawn as a darker segment inside the bar. */
  highlight?: number;
  href?: string;
  note?: string;
}

/**
 * A ranked list where the bar is the row background.
 *
 * Preferred over a pie chart for the same reason every dashboard eventually
 * abandons pie charts: humans compare lengths well and angles badly, and a
 * ranked list is also readable when it is a list of one.
 */
export function BarList({
  rows,
  empty = "Nothing to show yet.",
  highlightLabel,
}: {
  rows: BarRow[];
  empty?: string;
  highlightLabel?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">{empty}</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <div className="space-y-1">
      {highlightLabel ? (
        <p className="pb-1 text-[11px] text-muted-foreground">
          <span className="mr-1 inline-block size-2 rounded-sm bg-brand-400 align-middle" />
          {highlightLabel}
        </p>
      ) : null}
      {rows.map((row) => {
        const inner = (
          <div className="relative flex items-center gap-3 overflow-hidden rounded-md px-2 py-1.5">
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-md bg-navy-100 dark:bg-navy-900"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
            {row.highlight ? (
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-md bg-brand-200 dark:bg-brand-900"
                style={{ width: `${(row.highlight / max) * 100}%` }}
              />
            ) : null}
            <span className="relative min-w-0 flex-1 truncate text-sm">{row.label}</span>
            {row.note ? (
              <span className="relative shrink-0 text-xs text-muted-foreground">{row.note}</span>
            ) : null}
            <span className="relative shrink-0 text-sm font-medium tabular-nums">{row.value}</span>
          </div>
        );
        return row.href ? (
          <Link key={row.label} href={row.href} className="block transition-opacity hover:opacity-80">
            {inner}
          </Link>
        ) : (
          <div key={row.label}>{inner}</div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

/**
 * The five stages, widest first.
 *
 * Width is proportional to the largest stage rather than to the stage above, so
 * a pipeline that widens later -- which happens, because stages advance and
 * never regress -- is drawn honestly instead of being forced into a taper.
 */
export function StageFunnel({
  rows,
  hrefBase,
}: {
  rows: { stage: string; accounts: number }[];
  hrefBase?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.accounts));
  const total = rows.reduce((sum, r) => sum + r.accounts, 0);

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const pct = total === 0 ? 0 : Math.round((row.accounts / total) * 100);
        const body = (
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{row.stage}</span>
            <div className="h-7 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="flex h-full items-center justify-end rounded px-2 text-[11px] font-semibold text-white"
                style={{
                  width: `${Math.max((row.accounts / max) * 100, row.accounts > 0 ? 8 : 0)}%`,
                  // Later stages sit closer to brand green: progress you can see
                  // across the column without reading the labels.
                  backgroundColor: STAGE_COLORS[i] ?? STAGE_COLORS[0],
                }}
              >
                {row.accounts > 0 ? row.accounts : null}
              </div>
            </div>
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {pct}%
            </span>
          </div>
        );
        return hrefBase ? (
          <Link
            key={row.stage}
            href={`${hrefBase}${encodeURIComponent(row.stage)}`}
            className="block transition-opacity hover:opacity-85"
          >
            {body}
          </Link>
        ) : (
          <div key={row.stage}>{body}</div>
        );
      })}
    </div>
  );
}

const STAGE_COLORS = ["#00417a", "#2666bd", "#3a83d4", "#00c058", "#009a47"];
