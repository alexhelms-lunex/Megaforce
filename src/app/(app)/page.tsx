import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  PhoneCall,
  PhoneOff,
  Target,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarList, DailyBars, StageFunnel, StatCard, type DayBar } from "@/components/charts";
import { LifecycleFlag } from "@/components/lifecycle-flag";
import { InfoTip } from "@/components/info-tip";
import { createClient, currentUser, isPrivileged } from "@/lib/supabase/server";
import { CreditDashboard } from "./dashboards/credit";
import { AdminDashboard } from "./dashboards/admin";
import { Greeting } from "@/components/greeting";
import { daysSince } from "@/lib/format";
import type { LifecycleState } from "@/lib/lifecycle";

export const dynamic = "force-dynamic";

interface Kpis {
  owned: number;
  prospects: number;
  customers: number;
  at_risk: number;
  expiring_soon: number;
  available_pool: number;
  calls_7d: number;
  qualifying_7d: number;
  calls_prev_7d: number;
  unlogged: number;
  contacts_owned: number;
  my_limit: number | null;
}

const ZERO: Kpis = {
  owned: 0,
  prospects: 0,
  customers: 0,
  at_risk: 0,
  expiring_soon: 0,
  available_pool: 0,
  calls_7d: 0,
  qualifying_7d: 0,
  calls_prev_7d: 0,
  unlogged: 0,
  contacts_owned: 0,
  my_limit: null,
};

/**
 * The home screen.
 *
 * Built around one question: what should this person do in the next hour. The
 * work list comes before the charts for that reason -- a dashboard whose top
 * third is a summary of last quarter is a dashboard people scroll past.
 *
 * Role changes the scope, not the layout. A broker sees their own book, a
 * manager sees their subtree, and both see the same shapes, so nobody has to
 * learn a second screen when they get promoted.
 */
/**
 * The home screen, which is a different screen depending on who you are.
 *
 * ---------------------------------------------------------------------------
 * Everybody used to land on the sales dashboard: pipeline, call volume, stage
 * funnel, conversion rate. For a broker that is exactly right. For Customer
 * Credit every number on it was about work they do not do -- they hold no book,
 * make no calls, and their conversion rate is structurally zero -- and for an
 * administrator it was a book they do not own with none of the queues they are
 * responsible for.
 *
 * Alex, on what each role opens in the morning:
 *
 *   credit   credit increase requests and setting up credit
 *   broker   pipelines and sales
 *   manager  tracking the brokers
 *   admin    visibility into everything
 *
 * A role with the wrong dashboard does not complain, it simply stops opening
 * the application -- which is the failure mode worth avoiding.
 * ---------------------------------------------------------------------------
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const me = await currentUser();
  if (!me) return null;

  if (me.role === "credit") return <CreditDashboard me={me} />;
  if (me.role === "admin") return <AdminDashboard me={me} />;

  // Brokers, managers and account directors all work a book, so they share a
  // dashboard -- with the team table promoted to the top for a manager, whose
  // job is the people rather than the pipeline.
  const managerish = me.role === "manager" || isPrivileged(me.role);
  // A manager's job is the people, not the pipeline, so their brokers go above
  // the charts rather than below them.
  const leadWithTeam = me.role === "manager";
  const scope = managerish ? "team" : "mine";

  /*
   * Release overdue accounts before reading the numbers.
   *
   * The hourly cron is the primary route, but it depends on a Vercel plan, an
   * environment variable and a deployment all being right -- and every one of
   * those is a way for accounts to sit visibly overdue for weeks. This is the
   * backstop: the rule the whole system exists to apply should not be able to
   * stop working because somebody forgot to set a secret.
   *
   * sweep_if_due() rate-limits itself to once every fifteen minutes in SQL, so
   * a floor full of people refreshing dashboards runs it four times an hour,
   * not four hundred. Awaited rather than fired and forgotten, so the figures
   * below are computed after the release rather than one page load behind it.
   */
  await supabase.rpc("sweep_if_due", { p_max_age_minutes: 15 });

  const [kpiRes, dailyRes, funnelRes, industryRes, teamRes, worklistRes] = await Promise.all([
    supabase.rpc("dashboard_kpis", { p_scope: scope }),
    supabase.rpc("dashboard_calls_daily", { p_days: 14, p_scope: scope }),
    supabase.rpc("dashboard_stage_funnel", { p_scope: scope }),
    supabase.rpc("dashboard_industry_mix", { p_scope: scope, p_limit: 8 }),
    managerish ? supabase.rpc("dashboard_team", { p_days: 7 }) : Promise.resolve({ data: [] }),
    supabase
      .from("accounts_with_state")
      .select("id, name, status, stage, state, days_left, last_activity_at, owner_name, billing_city, billing_state")
      .in("state", ["overdue", "expiring", "warning"])
      .order("urgency", { ascending: true })
      .order("days_left", { ascending: true, nullsFirst: false })
      .limit(8),
  ]);

  // rpc() returning a table gives an array even for a single-row function.
  const kpis: Kpis = { ...ZERO, ...((kpiRes.data as Kpis[] | null)?.[0] ?? {}) };
  const daily = ((dailyRes.data ?? []) as { day: string; calls: number; qualifying: number }[]).map(
    (d): DayBar => ({ day: d.day, calls: Number(d.calls), qualifying: Number(d.qualifying) }),
  );
  const funnel = ((funnelRes.data ?? []) as { stage: string; accounts: number }[]).map((r) => ({
    stage: r.stage,
    accounts: Number(r.accounts),
  }));
  const industries = (industryRes.data ?? []) as {
    industry: string;
    accounts: number;
    customers: number;
    at_risk: number;
  }[];
  const team = (teamRes.data ?? []) as TeamRow[];
  const worklist = (worklistRes.data ?? []) as WorklistRow[];

  const conversion = kpis.calls_7d === 0 ? 0 : Math.round((kpis.qualifying_7d / kpis.calls_7d) * 100);
  const callDelta =
    kpis.calls_prev_7d === 0
      ? null
      : ((kpis.calls_7d - kpis.calls_prev_7d) / kpis.calls_prev_7d) * 100;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <Greeting name={me.full_name.split(" ")[0]} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {managerish
              ? "Your book and your brokers', and where it needs attention."
              : "Your book, and what it needs today."}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/available"
            className="inline-flex h-9 items-center rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            Claim from pool ({kpis.available_pool})
          </Link>
          <Link
            href="/accounts/new"
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            New company
          </Link>
        </div>
      </header>

      {/* --------------------------------------------------------------------
          Unlogged calls get their own band above everything else.

          An unlogged call is not an approved activity, so each one is an
          account quietly running its clock down while the broker believes the
          work is done. That is the single most expensive misunderstanding this
          system can allow, so it is stated before the numbers rather than
          buried in one of them.
         -------------------------------------------------------------------- */}
      {kpis.unlogged > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
          <PhoneOff className="size-5 shrink-0 text-amber-600" aria-hidden />
          <p className="min-w-0 flex-1 text-sm">
            <span className="inline-flex items-center gap-1 font-semibold">
              {kpis.unlogged} call{kpis.unlogged === 1 ? "" : "s"} not written up.
              <InfoTip k="unlogged" />
            </span>{" "}
            <span className="text-muted-foreground">
              A call only counts once it has a company, a contact, notes and a stage. Until then
              the account&apos;s clock keeps running.
            </span>
          </p>
          <Link
            href="/activity?logged=no"
            className="inline-flex h-8 shrink-0 items-center rounded-md bg-amber-600 px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            Write them up
          </Link>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          // Not "team accounts". Nothing here is a team: it is this
          // person's own book plus the books of everyone reporting to them,
          // and calling it a team made it read as a pooled figure belonging
          // to a group rather than a sum of individual books.
          label={managerish ? "Yours and your brokers'" : "Accounts held"}
          value={kpis.owned}
          icon={Building2}
          href="/accounts?mine=1"
          // The card counts accounts. It used to explain the prospect LIMIT,
          // which is a different number entirely -- and on a manager's screen,
          // where the card is a team total, the limit is not even their own.
          info={managerish ? "overseenAccounts" : "accountsHeld"}
          hint={
            kpis.my_limit
              ? `limit ${kpis.my_limit}`
              : `${kpis.prospects} prospects · ${kpis.customers} customers`
          }
          tone={kpis.my_limit && kpis.owned > kpis.my_limit ? "danger" : "default"}
        />
        <StatCard
          label="Needs attention"
          value={kpis.at_risk}
          icon={AlertTriangle}
          href="/accounts?preset=at-risk"
          info="atRisk"
          hint={`${kpis.expiring_soon} expiring within days`}
          tone={kpis.at_risk > 0 ? (kpis.expiring_soon > 0 ? "danger" : "warning") : "good"}
        />
        <StatCard
          label="Calls, last 7 days"
          value={kpis.calls_7d}
          icon={PhoneCall}
          href="/activity"
          info="callsSevenDays"
          delta={callDelta}
          hint={`${kpis.qualifying_7d} counted`}
        />
        <StatCard
          label="Calls that counted"
          value={`${conversion}%`}
          icon={Target}
          info="hitRate"
          hint={
            conversion >= 50
              ? "healthy"
              : kpis.calls_7d === 0
                ? "no calls yet this week"
                : "under 60s, or missing an outcome"
          }
          tone={kpis.calls_7d > 0 && conversion < 40 ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ------------------------------------------------------------------
            Work this list. First, biggest, and above the fold.
           ------------------------------------------------------------------ */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-1.5 text-base">Work this list today<InfoTip k="urgencySort" /></CardTitle>
              <p className="text-xs text-muted-foreground">
                Closest to being released, first.
              </p>
            </div>
            <Link href="/accounts?preset=at-risk" className="text-xs font-medium text-primary hover:underline">
              See all {kpis.at_risk}
            </Link>
          </CardHeader>
          <CardContent>
            {worklist.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <TrendingUp className="size-6 text-brand-500" aria-hidden />
                <p className="text-sm font-medium">Nothing at risk.</p>
                <p className="text-xs text-muted-foreground">
                  Every account you {managerish ? "hold or oversee" : "hold"} has been worked
                  inside its window.
                </p>
              </div>
            ) : (
              <ul className="divide-y">
                {worklist.map((row) => {
                  const idle = daysSince(row.last_activity_at);
                  return (
                    <li key={row.id}>
                      <Link
                        href={`/accounts/${row.id}`}
                        className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{row.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[
                              row.billing_city && row.billing_state
                                ? `${row.billing_city}, ${row.billing_state}`
                                : null,
                              row.stage,
                              managerish ? row.owner_name : null,
                              idle === null ? "never worked" : `${idle}d since last activity`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <LifecycleFlag state={row.state} daysLeft={row.days_left} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Calling, last 14 days</CardTitle>
            <p className="text-xs text-muted-foreground">
              Green is the part that reset an account&apos;s clock.
            </p>
          </CardHeader>
          <CardContent>
            <DailyBars data={daily} />
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Calls made</dt>
                <dd className="font-semibold tabular-nums">
                  {daily.reduce((s, d) => s + d.calls, 0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Counted</dt>
                <dd className="font-semibold tabular-nums text-brand-600">
                  {daily.reduce((s, d) => s + d.qualifying, 0)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">Pipeline by stage<InfoTip k="stageFunnel" /></CardTitle>
            <p className="text-xs text-muted-foreground">
              Stage advances when a call is logged against it, and never moves backwards.
            </p>
          </CardHeader>
          <CardContent>
            <StageFunnel rows={funnel} hrefBase="/accounts?stage=" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">Industry mix<InfoTip k="industryMix" /></CardTitle>
            <p className="text-xs text-muted-foreground">
              Where the book sits, and how much of each vertical has converted.
            </p>
          </CardHeader>
          <CardContent>
            <BarList
              highlightLabel="customers"
              rows={industries.map((i) => ({
                label: i.industry,
                value: Number(i.accounts),
                highlight: Number(i.customers),
                note: Number(i.at_risk) > 0 ? `${i.at_risk} at risk` : undefined,
                href: `/accounts?industry=${encodeURIComponent(i.industry)}`,
              }))}
              empty="No accounts carry an industry yet."
            />
          </CardContent>
        </Card>
      </div>

      {/* Managers get it at the top instead — see above. */}
      {managerish && !leadWithTeam && team.length > 0 ? <TeamTable rows={team} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TeamRow {
  user_id: string;
  full_name: string;
  role: string;
  location: string | null;
  prospect_limit: number | null;
  owned: number;
  at_risk: number;
  customers: number;
  calls: number;
  qualifying: number;
  unlogged: number;
}

interface WorklistRow {
  id: string;
  name: string;
  status: string;
  stage: string;
  state: LifecycleState;
  days_left: number | null;
  last_activity_at: string | null;
  owner_name: string | null;
  billing_city: string | null;
  billing_state: string | null;
}

/**
 * The team rollup.
 *
 * Sorted by accounts at risk rather than by calls made, because the useful
 * question for a manager is not who is busiest -- it is whose book is about to
 * lose accounts. Activity is shown next to it so the two can be read together:
 * high calls with high risk is a coverage problem, low calls with high risk is
 * a different conversation entirely.
 */
function TeamTable({ rows }: { rows: TeamRow[] }) {
  const sorted = [...rows].sort((a, b) => Number(b.at_risk) - Number(a.at_risk));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your brokers</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sorted by accounts at risk, not by calls made.
        </p>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-6 py-2 font-medium">Rep</th>
                <th className="px-3 py-2 text-right font-medium">Accounts</th>
                <th className="px-3 py-2 text-right font-medium">At risk</th>
                <th className="px-3 py-2 text-right font-medium">Customers</th>
                <th className="px-3 py-2 text-right font-medium">Calls 7d</th>
                <th className="px-3 py-2 text-right font-medium">Counted</th>
                <th className="px-6 py-2 text-right font-medium">Unlogged</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const over = r.prospect_limit !== null && Number(r.owned) > r.prospect_limit;
                return (
                  <tr key={r.user_id} className="border-b last:border-b-0 hover:bg-accent/50">
                    <td className="px-6 py-2.5">
                      <Link href={`/accounts?owner=${r.user_id}`} className="font-medium hover:underline">
                        {r.full_name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {[r.role, r.location].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.owned}
                      {r.prospect_limit !== null ? (
                        <span className={over ? "text-destructive" : "text-muted-foreground"}>
                          {" "}
                          / {r.prospect_limit}
                        </span>
                      ) : null}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right tabular-nums ${
                        Number(r.at_risk) > 0 ? "font-semibold text-destructive" : ""
                      }`}
                    >
                      {r.at_risk}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.customers}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.calls}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-brand-600">
                      {r.qualifying}
                    </td>
                    <td
                      className={`px-6 py-2.5 text-right tabular-nums ${
                        Number(r.unlogged) > 0 ? "text-amber-600" : "text-muted-foreground"
                      }`}
                    >
                      {r.unlogged}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

