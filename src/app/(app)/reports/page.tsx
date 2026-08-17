import Link from "next/link";
import { AlertOctagon, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { TrendChart, type TrendSeries } from "@/components/trend-chart";
import { currentUser } from "@/lib/supabase/server";
import {
  METRICS,
  SERIES_METRICS,
  daysAgo,
  fetchBreakdown,
  fetchDimensions,
  fetchSeries,
  fetchTotals,
  grainFor,
  isoToday,
  spanDays,
  type MetricValue,
  type ReportError,
  type Scope,
  type SeriesKey,
} from "@/lib/reports";
import {
  BreakdownSearch,
  DimensionTabs,
  MetricToggle,
  RangeControls,
  SelectedMark,
} from "./controls";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * The colours the chart draws with.
 *
 * Deliberately not the chart-1..5 tokens in sequence. These are chosen so that
 * the two metrics almost always shown together -- calls and counted -- are
 * clearly separable, and so "lost to the clock" is the only red on the screen.
 */
const SERIES_COLOUR: Record<SeriesKey, string> = {
  calls: "#6060ff",
  approved: "#00ad68",
  emails: "#9494ff",
  claimed: "#00d982",
  lost: "#d81c3f",
};

/**
 * Reports.
 *
 * ---------------------------------------------------------------------------
 * Built to the shape of an analytics tool rather than as a page of charts: a
 * window with a comparison period, scorecards that are also the chart's legend,
 * one trend chart, and a dimension explorer underneath.
 *
 * The scorecards being buttons is the important part. Pressing one adds that
 * metric to the chart. The cards and the chart are the same numbers at two
 * resolutions -- a total and its shape over time -- rather than two displays
 * that happen to sit near each other, and treating them as one thing is what
 * makes a screen like this answer follow-up questions instead of just the first
 * one.
 *
 * Everything is in the URL, so a report can be sent to somebody.
 * ---------------------------------------------------------------------------
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const v = params[key];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const me = await currentUser();
  const managerish = me ? me.role !== "broker" : false;

  const days = ["7", "28", "90", "365"].includes(one("days")) ? one("days") : "28";
  const scope: Scope = one("scope") === "mine" ? "mine" : managerish ? "team" : "mine";
  const from = daysAgo(Number(days) - 1);
  const to = isoToday();
  const grain = grainFor(from, to);

  const chosen = (one("metrics") || "calls,approved")
    .split(",")
    .filter((m): m is SeriesKey => (SERIES_METRICS as readonly string[]).includes(m));
  const selected = chosen.length > 0 ? chosen : (["calls"] as SeriesKey[]);

  const dimensions = await fetchDimensions();
  const dim = dimensions.some((d) => d.key === one("dim")) ? one("dim") : "broker";
  const search = one("q");
  const page = Math.max(1, Number(one("page")) || 1);

  const [totals, series, breakdown] = await Promise.all([
    fetchTotals(from, to, scope),
    fetchSeries(from, to, scope, grain),
    fetchBreakdown(from, to, scope, dim, search, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);

  const failure = totals.error ?? series.error ?? breakdown.error;
  const activeDimension = dimensions.find((d) => d.key === dim);
  const pages = Math.max(1, Math.ceil(breakdown.total / PAGE_SIZE));

  const chartSeries: TrendSeries[] = selected.map((key) => ({
    key,
    label: METRICS.find((m) => m.key === key)?.label ?? key,
    color: SERIES_COLOUR[key],
    values: series.points.map((p) => p[key]),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Reports
            <InfoTip k="reportsScreen" side="bottom" />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatRange(from, to)} · compared against the {spanDays(from, to)} days before ·{" "}
            {grain === "week" ? "weekly" : "daily"}
          </p>
        </div>
        <RangeControls scope={scope} days={days} />
      </div>

      {failure ? <Failure error={failure} /> : null}

      {/* ---- scorecards, which are also the chart's legend ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.metrics.map((m) => (
          <MetricToggle
            key={m.key}
            metricKey={m.key}
            active={(selected as string[]).includes(m.key)}
          >
            <ScoreCard
              metric={m}
              selected={(selected as string[]).includes(m.key)}
              colour={SERIES_COLOUR[m.key as SeriesKey]}
            />
          </MetricToggle>
        ))}
      </div>

      {/* ---- the trend ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            Over time
            <InfoTip
              side="bottom"
              text="The metrics selected above, bucketed by day up to three months and by week beyond it. Every bucket in the range is drawn, including the empty ones — a chart that skips quiet days makes a dead week look busy."
            />
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Press a card above to add or remove it here.
          </p>
        </CardHeader>
        <CardContent>
          <TrendChart
            labels={series.points.map((p) => p.bucket)}
            series={chartSeries}
            grain={grain}
          />
        </CardContent>
      </Card>

      {/* ---- the dimension explorer ---- */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-1.5 text-base">
              Break it down
              <InfoTip
                side="bottom"
                text="The same period, split by whichever dimension you choose. Calls are credited to whoever made them and accounts to whoever holds them, so a manager who works a broker's account shows calls under their own name and the account under the broker's."
              />
            </CardTitle>
            <BreakdownSearch placeholder={`Search ${activeDimension?.label.toLowerCase() ?? ""}…`} />
          </div>
          <DimensionTabs dimensions={dimensions} active={dim} />
          {activeDimension?.hint ? (
            <p className="text-xs text-muted-foreground">{activeDimension.hint}</p>
          ) : null}
        </CardHeader>
        <CardContent className="px-0">
          {breakdown.rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {search
                ? `Nothing matches “${search}”.`
                : "Nothing to report for this period."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2 font-medium">{activeDimension?.label}</th>
                    <Th help="Every call captured against these accounts, counted or not.">
                      Calls
                    </Th>
                    <Th help="Activities that met the bar and reset an account's clock.">
                      Counted
                    </Th>
                    <Th help="Counted divided by calls. A low rate is usually short calls or calls nobody wrote up.">
                      Hit rate
                    </Th>
                    <Th help="Accounts held right now. A snapshot, not a figure for the period.">
                      Accounts
                    </Th>
                    <Th help="Accounts taken out of the available pool during this period.">
                      Claimed
                    </Th>
                    <Th help="Accounts that timed out and went back to the pool during this period.">
                      Lost
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((r) => (
                    <tr key={r.key} className="border-b last:border-b-0 hover:bg-accent/40">
                      <td className="px-5 py-2.5 font-medium">{r.label}</td>
                      <Td>{r.calls.toLocaleString()}</Td>
                      <Td>{r.approved.toLocaleString()}</Td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className="inline-flex items-center gap-2">
                          <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full bg-brand-500"
                              style={{ width: `${Math.min(100, r.hitRate)}%` }}
                            />
                          </span>
                          {r.hitRate}%
                        </span>
                      </td>
                      <Td>{r.accounts.toLocaleString()}</Td>
                      <Td>{r.claimed.toLocaleString()}</Td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={r.lost > 0 ? "font-medium text-destructive" : ""}>
                          {r.lost.toLocaleString()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 ? (
            <div className="flex items-center justify-between px-5 pt-3 text-sm">
              <span className="text-muted-foreground">
                Page {page} of {pages} · {breakdown.total.toLocaleString()} rows
              </span>
              <div className="flex gap-2">
                <PageLink params={params} page={page - 1} disabled={page <= 1}>
                  ← Previous
                </PageLink>
                <PageLink params={params} page={page + 1} disabled={page >= pages}>
                  Next →
                </PageLink>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ScoreCard({
  metric,
  selected,
  colour,
}: {
  metric: MetricValue;
  selected: boolean;
  colour?: string;
}) {
  const rising = metric.delta !== null && metric.delta > 0;
  const flat = metric.delta === null || Math.round(metric.delta) === 0;
  // Up is not automatically good. More calls is good; more accounts lost to the
  // clock is not, and a green arrow on a rising loss figure is worse than no
  // arrow at all.
  const helpful = flat ? null : metric.good === "up" ? rising : !rising;
  const Arrow = flat ? Minus : rising ? ArrowUpRight : ArrowDownRight;

  return (
    <div
      className={`h-full rounded-xl border bg-card p-4 transition-all ${
        selected ? "border-transparent ring-2" : "hover:border-foreground/20"
      }`}
      style={selected && colour ? { boxShadow: `inset 0 0 0 2px ${colour}` } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {metric.label}
        </span>
        <span className="flex items-center gap-1">
          <InfoTip side="bottom" text={metric.hint} />
          {selected ? <SelectedMark /> : null}
        </span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
        {metric.value.toLocaleString()}
        {metric.suffix ?? ""}
      </p>
      <p className="mt-1 flex items-center gap-1 text-xs">
        {metric.previous === null ? (
          <span className="text-muted-foreground">no comparison</span>
        ) : (
          <>
            <Arrow
              className={`size-3.5 ${
                helpful === null
                  ? "text-muted-foreground"
                  : helpful
                    ? "text-brand-600"
                    : "text-destructive"
              }`}
              aria-hidden
            />
            <span
              className={
                helpful === null
                  ? "text-muted-foreground"
                  : helpful
                    ? "font-medium text-brand-600"
                    : "font-medium text-destructive"
              }
            >
              {metric.delta === null
                ? "new"
                : `${Math.abs(Math.round(metric.delta))}%`}
            </span>
            <span className="text-muted-foreground">
              vs {metric.previous.toLocaleString()}
              {metric.suffix ?? ""}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function Th({ children, help }: { children: React.ReactNode; help: string }) {
  return (
    <th className="px-3 py-2 text-right font-medium">
      <span className="inline-flex items-center gap-1">
        {children}
        <InfoTip side="bottom" text={help} />
      </span>
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2.5 text-right tabular-nums">{children}</td>;
}

function Failure({ error }: { error: ReportError }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="space-y-2 py-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <AlertOctagon className="size-4" aria-hidden />
          Some of these figures could not be read
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {error.schema
            ? "The database is behind this version of the app — the reporting functions have not been applied yet. An administrator should re-run setup."
            : "The reporting query failed."}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
        <p className="pt-1 text-sm">
          <Link href="/admin" className="font-medium text-primary hover:underline">
            Open the Admin screen →
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function PageLink({
  params,
  page,
  disabled,
  children,
}: {
  params: Record<string, string | string[] | undefined>;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-full border px-4 py-1.5 text-muted-foreground/50">{children}</span>
    );
  }
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "page") continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value) next.set(k, value);
  }
  next.set("page", String(page));
  return (
    <Link
      href={`/reports?${next.toString()}`}
      className="rounded-full border px-4 py-1.5 font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}

function formatRange(from: string, to: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(from)} – ${fmt(to)}`;
}
