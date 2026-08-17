"use client";

import { useMemo, useState } from "react";

export interface TrendSeries {
  key: string;
  label: string;
  /** A CSS colour. Passed in so the palette lives with the screen's tokens. */
  color: string;
  values: number[];
}

/**
 * The trend chart.
 *
 * ---------------------------------------------------------------------------
 * Drawn as inline SVG rather than with a charting library. A chart library is
 * 200KB of JavaScript to draw some lines, and it arrives with its own palette,
 * its own type ramp and its own idea of what a tooltip looks like -- three
 * things this application already has opinions about.
 *
 * The behaviour that matters is the crosshair. A line chart without one is
 * decoration: you can see that Tuesday was bad and not what "bad" was. Moving
 * the pointer anywhere over the plot snaps to the nearest bucket and reads out
 * every series at once, which is the whole reason to put several series on one
 * chart instead of several charts.
 * ---------------------------------------------------------------------------
 */
export function TrendChart({
  labels,
  series,
  height = 260,
  grain = "day",
}: {
  labels: string[];
  series: TrendSeries[];
  height?: number;
  /**
   * Day or week. Passed as a STRING, not as a formatting function.
   *
   * It was a function, and that is what crashed the reports screen. A prop
   * crossing from a server component into a client one has to survive being
   * serialised, and a closure cannot -- React refuses it outright. The error
   * says so clearly and then Next redacts the message in production, so the
   * screen showed "an error occurred in the Server Components render" and
   * nothing else.
   */
  grain?: "day" | "week";
}) {
  const [hover, setHover] = useState<number | null>(null);

  // A viewBox in abstract units with preserveAspectRatio off lets the chart
  // stretch to any width while the maths stays in one coordinate system.
  const W = 1000;
  const H = height;
  const PAD = { top: 16, right: 12, bottom: 26, left: 40 };

  const max = useMemo(() => {
    const highest = Math.max(1, ...series.flatMap((s) => s.values));
    // Round up to something a human would choose, so the top gridline is a
    // number rather than 37.
    const magnitude = Math.pow(10, Math.floor(Math.log10(highest)));
    return Math.ceil(highest / magnitude) * magnitude;
  }, [series]);

  const n = labels.length;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const gridlines = [0, 0.25, 0.5, 0.75, 1];

  // Show at most eight date labels; more than that and they collide at any
  // realistic width.
  const labelStep = Math.max(1, Math.ceil(n / 8));

  if (n === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        No data in this period.
      </p>
    );
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[260px] w-full touch-none"
        role="img"
        aria-label={`Trend of ${series.map((s) => s.label).join(", ")}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - box.left) / box.width;
          const px = ratio * W;
          const i = Math.round(((px - PAD.left) / plotW) * (n - 1));
          setHover(Math.min(n - 1, Math.max(0, i)));
        }}
      >
        {gridlines.map((g) => (
          <g key={g}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top + plotH * (1 - g)}
              y2={PAD.top + plotH * (1 - g)}
              stroke="currentColor"
              className="text-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={PAD.left - 8}
              y={PAD.top + plotH * (1 - g) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px]"
              style={{ fontSize: 11 }}
            >
              {Math.round(max * g)}
            </text>
          </g>
        ))}

        {labels.map((label, i) =>
          i % labelStep === 0 ? (
            <text
              key={label + i}
              x={x(i)}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 11 }}
            >
              {formatBucket(label, grain)}
            </text>
          ) : null,
        )}

        {series.map((s) => {
          const line = s.values.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(v)}`).join(" ");
          const area = `${line} L ${x(n - 1)} ${PAD.top + plotH} L ${x(0)} ${PAD.top + plotH} Z`;
          return (
            <g key={s.key}>
              <path d={area} fill={s.color} opacity={0.1} />
              <path
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}

        {hover !== null ? (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="currentColor"
              className="text-muted-foreground"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(s.values[hover] ?? 0)}
                r={4}
                fill={s.color}
                stroke="var(--card)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        ) : null}
      </svg>

      {/* The readout sits below rather than floating over the plot. A floating
          tooltip covers the very data you moved the pointer towards, and on a
          chart this wide it also has to decide which side to open on. */}
      <div className="mt-1 flex min-h-[2.25rem] flex-wrap items-center gap-x-5 gap-y-1 border-t pt-2 text-xs">
        <span className="font-medium tabular-nums text-foreground">
          {hover === null
            ? `${labels.length} ${labels.length === 1 ? "period" : "periods"}`
            : formatBucket(labels[hover], grain)}
        </span>
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
            <span className="font-semibold tabular-nums text-foreground">
              {hover === null
                ? s.values.reduce((a, b) => a + b, 0).toLocaleString()
                : (s.values[hover] ?? 0).toLocaleString()}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * An ISO date as a short label.
 *
 * Lives here rather than on the page for the reason above: the page is a server
 * component, and a formatter it owned would have to be handed across the
 * boundary as a function. A week bucket names the week it starts.
 */
function formatBucket(iso: string, grain: "day" | "week"): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const label = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return grain === "week" ? `w/c ${label}` : label;
}
