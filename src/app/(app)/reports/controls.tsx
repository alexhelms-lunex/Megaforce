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

const RANGES = [
  { key: "7", label: "7 days" },
  { key: "28", label: "28 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "12 months" },
];

export function RangeControls({ scope, days }: { scope: string; days: string }) {
  const go = useGo();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-full border p-0.5">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => go({ days: r.key })}
            aria-pressed={days === r.key}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              days === r.key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="inline-flex rounded-full border p-0.5">
        {[
          { key: "mine", label: "My book" },
          { key: "team", label: "Everyone I can see" },
        ].map((s) => (
          <button
            key={s.key}
            onClick={() => go({ scope: s.key })}
            aria-pressed={scope === s.key}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              scope === s.key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <InfoTip
        side="bottom"
        text="Every figure is compared against the period immediately before it, of exactly the same length — so a 28-day report is compared against the 28 days before that, never against a calendar month."
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
