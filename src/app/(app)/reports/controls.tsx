"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Search, X } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { SERIES_METRICS, type SeriesKey } from "@/lib/report-metrics";

/**
 * Everything on this screen writes to the URL.
 *
 * A report somebody cannot send to their manager is half a report. Period,
 * scope, chosen metrics, dimension, search and page all live in the query
 * string, so the address bar always describes exactly what is on screen and
 * the Back button steps through the questions somebody actually asked.
 */
function useGo() {
  const router = useRouter();
  const params = useSearchParams();
  return (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    router.push(`/reports?${next.toString()}`);
  };
}

/**
 * The period picker.
 *
 * Alex: "A period is 7 days for our sake. A period begins on Monday and ends on
 * Sunday evening."
 *
 * So the tabs are named in WEEKS, not days. "28 days" and "4 weeks" are the
 * same length and they are not the same window: one starts on whatever day you
 * happened to open the screen, the other always starts on a Monday. Naming them
 * in weeks is the only labelling that stays honest once the window is anchored,
 * and it is how the floor already talks -- nobody says "how did we do over the
 * last twenty-eight days".
 *
 * Each tab carries what it actually means underneath, because "13 weeks" and
 * "the thirteen complete weeks ending last Sunday" are different promises and
 * only the second one is true.
 */
const PERIOD_TABS = [
  { key: "this-week", label: "This week", hint: "Monday to today. Still running." },
  { key: "last-week", label: "Last week", hint: "The last complete Monday to Sunday." },
  { key: "4-weeks", label: "4 weeks", hint: "The four complete weeks ending last Sunday." },
  { key: "13-weeks", label: "13 weeks", hint: "A quarter, as thirteen complete weeks." },
  { key: "52-weeks", label: "52 weeks", hint: "A year, as fifty-two complete weeks." },
];

const COMPARE_TABS = [
  { key: "previous", label: "Previous", hint: "The same length of time immediately before." },
  {
    key: "previous-week",
    label: "Week earlier",
    hint: "The same window shifted back seven days — same weekdays, same length.",
  },
  {
    key: "last-year",
    label: "Last year",
    hint:
      "Fifty-two weeks back. 364 days rather than 365, so the window lands on a Monday " +
      "again and Tuesdays are compared against Tuesdays.",
  },
  { key: "none", label: "Off", hint: "Show the figures on their own." },
];

function Pills({
  options,
  active,
  onPick,
}: {
  options: { key: string; label: string; hint: string }[];
  active: string;
  onPick: (key: string) => void;
}) {
  return (
    <div className="inline-flex rounded-full border p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onPick(o.key)}
          aria-pressed={active === o.key}
          title={o.hint}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            active === o.key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function RangeControls({
  scope,
  period,
  compare,
}: {
  scope: string;
  period: string;
  compare: string;
}) {
  const go = useGo();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Period
        </span>
        {/* Clearing ?days= as well: an old bookmark carries it, and leaving it
            in the URL means the legacy fallback fights the new control. */}
        <Pills
          options={PERIOD_TABS}
          active={period}
          onPick={(key) => go({ period: key, days: null })}
        />
        <InfoTip
          side="bottom"
          text="A period runs Monday to Sunday. Everything except This week ends on the last completed Sunday, so a part-finished week is never compared against a whole one."
        />
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Compare
        </span>
        <Pills options={COMPARE_TABS} active={compare} onPick={(key) => go({ cmp: key })} />
      </div>

      <Pills
        options={[
          { key: "mine", label: "My book", hint: "Only accounts you hold." },
          {
            key: "team",
            label: "Everyone I can see",
            hint: "You and everybody who reports to you, however many levels down.",
          },
        ]}
        active={scope}
        onPick={(key) => go({ scope: key })}
      />
    </div>
  );
}

/**
 * The metric picker.
 *
 * A card is a button. Pressing it adds or removes that metric from the chart
 * below, which is how Search Console works and is the right model: the
 * scorecards and the chart are the same numbers at two resolutions, not two
 * separate displays that happen to be near each other.
 */
export function MetricToggle({
  metricKey,
  active,
  children,
}: {
  metricKey: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const go = useGo();
  const params = useSearchParams();

  const selectable = (SERIES_METRICS as readonly string[]).includes(metricKey);

  function toggle() {
    if (!selectable) return;
    const current = (params.get("metrics") ?? "calls,approved")
      .split(",")
      .filter(Boolean) as SeriesKey[];
    const next = active
      ? current.filter((m) => m !== metricKey)
      : [...current, metricKey as SeriesKey];
    // Never leave the chart with nothing to draw; an empty chart reads as
    // broken rather than as a choice.
    go({ metrics: next.length === 0 ? "calls" : next.join(",") }, false);
  }

  if (!selectable) return <div className="h-full">{children}</div>;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      className="h-full w-full text-left"
    >
      {children}
    </button>
  );
}

export function DimensionTabs({
  dimensions,
  active,
}: {
  dimensions: { key: string; label: string; hint: string }[];
  active: string;
}) {
  const go = useGo();
  return (
    <div className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {dimensions.map((d) => (
        <button
          key={d.key}
          onClick={() => go({ dim: d.key, q: null })}
          aria-pressed={active === d.key}
          title={d.hint}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            active === d.key
              ? "bg-primary text-primary-foreground"
              : "border text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

export function BreakdownSearch({ placeholder }: { placeholder: string }) {
  const go = useGo();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  useEffect(() => setQ(params.get("q") ?? ""), [params]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go({ q });
      }}
      className="relative w-full sm:w-64"
    >
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 w-full rounded-full border bg-background pl-9 pr-8 text-sm outline-none focus:border-ring"
      />
      {q ? (
        <button
          type="button"
          onClick={() => {
            setQ("");
            go({ q: null });
          }}
          aria-label="Clear the search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </form>
  );
}

/** A checkmark shown on selected metric cards, so selection is not colour alone. */
export function SelectedMark() {
  return (
    <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
      <Check className="size-2.5" aria-hidden />
    </span>
  );
}
