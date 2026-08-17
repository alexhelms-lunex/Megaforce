import Link from "next/link";
import { AlertOctagon, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { TrendChart, type TrendSeries } from "@/components/trend-chart";
import { currentUser } from "@/lib/supabase/server";
import {
  METRICS,
  SERIES_METRICS,
  fetchBreakdown,
  fetchDimensions,
  fetchSeries,
  fetchTotals,
  formatWindow,
  grainFor,
  isCompareKey,
  isPeriodKey,
  resolveCompare,
  resolvePeriod,
  type MetricValue,
  type ReportError,
  type Scope,
  type SeriesKey,
} from "@/lib/reports";
import { CreditReport } from "./credit-report";
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
  const role = me?.role ?? "broker";

  /*
   * A period is a number of WEEKS, Monday to Sunday.
   *
   * Alex: "A period is 7 days for our sake. A period begins on Monday and ends
   * on Sunday evening."
   *
   * The old control counted days back from today, which meant the same report
   * covered a different set of Mondays depending on which day of the week you
   * opened it -- so two people comparing notes were never looking at the same
   * numbers. resolvePeriod() snaps both ends to the week; every figure on this
   * screen follows from those two dates.
   *
   * The old ?days= links are still honoured. A bookmark that stops working is
   * indistinguishable from a broken screen.
   */
  const LEGACY: Record<string, string> = {
    "7": "last-week",
    "28": "4-weeks",
    "90": "13-weeks",
    "365": "52-weeks",
  };
  const requestedPeriod = one("period") || LEGACY[one("days")] || "4-weeks";
  const requestedCompare = one("cmp");
  const period = resolvePeriod(isPeriodKey(requestedPeriod) ? requestedPeriod : "4-weeks");
  const compare = resolveCompare(
    period,
    isCompareKey(requestedCompare) ? requestedCompare : "previous",
  );

  const scope: Scope = one("scope") === "mine" ? "mine" : managerish ? "team" : "mine";
  const from = period.from;
  const to = period.to;
  const against = { from: compare.from, to: compare.to };
  const grain = grainFor(from, to);

  const chosen = (one("metrics") || (role === "manager" ? "calls,approved,lost" : "calls,approved"))
    .split(",")
    .filter((m): m is SeriesKey => (SERIES_METRICS as readonly string[]).includes(m));
  const selected = chosen.length > 0 ? chosen : (["calls"] as SeriesKey[]);

  const search = one("q");
  const page = Math.max(1, Number(one("page")) || 1);

  /*
   * Four queries, two waves instead of three.
   *
   * The dimension list used to be awaited on its own line before anything else
   * started, because the breakdown needs a validated dimension name. Only the
   * BREAKDOWN needs it though -- the totals and the series do not -- so those
   * two were sitting idle through a round trip for no reason. Starting them
   * first takes a whole trip to Supabase off the critical path of the screen
   * somebody just clicked on, and reporting was the screen singled out as slow.
   */
  const totalsPromise = fetchTotals(from, to, scope, against);
  const seriesPromise = fetchSeries(from, to, scope, grain);
  /*
   * The comparison line on the chart.
   *
   * A second call rather than a second set of columns from the first: the two
   * windows have different numbers of buckets when a period is part-finished,
   * and forcing them into one row set means picking which one is "the" bucket
   * list. Drawn dashed and aligned by POSITION -- week one against week one --
   * which is what "compared against" means to somebody reading a chart.
   */
  const comparePromise =
    compare.from && compare.to
      ? fetchSeries(compare.from, compare.to, scope, grain)
      : Promise.resolve({ points: [], error: null });

  const dimensions = await fetchDimensions();
  /*
   * The default breakdown depends on the job.
   *
   * A manager opens this to track their brokers, so the useful first cut is by
   * person. A broker has only themselves in it, and a row of one is not a
   * breakdown -- their book divides usefully by industry instead. An admin
   * looks across offices.
   *
   * A default is not a restriction: every dimension stays in the menu for
   * everybody. This only decides which one the page opens on.
   */
  const defaultDim =
    role === "broker" || role === "ad" ? "industry" : role === "admin" ? "branch" : "broker";
  const requested = one("dim");
  const dim = dimensions.some((d) => d.key === requested)
    ? requested
    : dimensions.some((d) => d.key === defaultDim)
      ? defaultDim
      : "broker";

  const [totals, series, priorSeries, breakdown] = await Promise.all([
    totalsPromise,
    seriesPromise,
    comparePromise,
    fetchBreakdown(from, to, scope, dim, search, PAGE_SIZE, (page - 1) * PAGE_SIZE, against),
  ]);

  const failure = totals.error ?? series.error ?? breakdown.error;
  const activeDimension = dimensions.find((d) => d.key === dim);
  /*
   * "Off" has to be enforced here, not by the query.
   *
   * report_window falls back to its own default comparison when it is handed
   * nulls, which is right for every caller that has not been updated and wrong
   * for somebody who has just pressed Off. Stripping the figures after the fact
   * keeps one code path instead of two and makes Off mean what it says.
   */
  const comparing = compare.key !== "none";
  const metrics = comparing
    ? totals.metrics
    : totals.metrics.map((m) => ({ ...m, previous: null, delta: null }));
  const pages = Math.max(1, Math.ceil(breakdown.total / PAGE_SIZE));

  const chartSeries: TrendSeries[] = selected.flatMap((key) => {
    const label = METRICS.find((m) => m.key === key)?.label ?? key;
    const line: TrendSeries = {
      key,
      label,
      color: SERIES_COLOUR[key],
      values: series.points.map((p) => p[key]),
    };
    if (priorSeries.points.length === 0) return [line];
    return [
      line,
      {
        key: `${key}__prior`,
        label: `${label}, ${compare.label}`,
        color: SERIES_COLOUR[key],
        dashed: true,
        values: priorSeries.points.map((p) => p[key]),
      },
    ];
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Reports
            <InfoTip k="reportsScreen" side="bottom" />
          </h1>
          {/* The dates spelled out, both of them.
              A screen that says "4 weeks" and "compared against the previous
              period" has told you the shape of the question and not the
              question. Somebody arguing about a number needs to know exactly
              which Mondays are in it. */}
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{formatWindow(from, to)}</span>
            {period.partial ? " · week still running" : ""}
            {compare.from && compare.to
              ? ` · vs ${formatWindow(compare.from, compare.to)}`
              : " · no comparison"}
            {" · "}
            {grain === "week" ? "weekly" : "daily"}
          </p>
        </div>
        <RangeControls scope={scope} period={period.key} compare={compare.key} />
      </div>

      {failure ? <Failure error={failure} /> : null}

      {/* Credit first, and above the selling figures, because for this role
          those figures are structurally zero -- they hold no book and make no
          calls. The rest of the page stays available; it simply is not the
          part of it they came for. */}
      {role === "credit" ? <CreditReport from={from} to={to} window={formatWindow(from, to)} /> : null}

      {/* ---- scorecards, which are also the chart's legend ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <MetricToggle
            key={m.key}
            metricKey={m.key}
            active={(selected as string[]).includes(m.key)}
          >
            <ScoreCard
              metric={m}
              selected={(selected as string[]).includes(m.key)}
              colour={SERIES_COLOUR[m.key as SeriesKey]}
              compareLabel={compare.label}
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
                    {comparing ? (
                      <Th
                        help={`Counted activities in this row against ${compare.label}. This is the column that says which broker moved, rather than only that the team did.`}
                      >
                        vs {compare.label}
                      </Th>
                    ) : null}
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
                      {comparing ? (
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <Movement now={r.approved} before={r.prevApproved} />
                        </td>
                      ) : null}
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
  compareLabel,
}: {
  metric: MetricValue;
  selected: boolean;
  colour?: string;
  compareLabel: string;
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
            {/* Names the comparison rather than just the number. "vs 412" on a
                screen with three possible comparisons is a number nobody can
                check without going back to the picker. */}
            <span className="truncate text-muted-foreground">
              vs {metric.previous.toLocaleString()}
              {metric.suffix ?? ""} · {compareLabel}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * One row's movement against the comparison window.
 *
 * Shows the CHANGE and the figure it moved from, not a percentage. On a row
 * that did two counted activities last week and three this week, "+50%" is
 * arithmetically true and useless; "+1 from 2" is what somebody can act on.
 * Percentages are for the totals at the top, where the denominators are large
 * enough to mean something.
 */
function Movement({ now, before }: { now: number; before: number | null }) {
  if (before === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const change = now - before;
  if (change === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        level at {before.toLocaleString()}
      </span>
    );
  }
  return (
    <span
      className={`text-xs font-medium ${change > 0 ? "text-brand-600" : "text-destructive"}`}
    >
      {change > 0 ? "+" : "−"}
      {Math.abs(change).toLocaleString()}
      <span className="ml-1 font-normal text-muted-foreground">
        from {before.toLocaleString()}
      </span>
    </span>
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

