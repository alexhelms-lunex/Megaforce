import Link from "next/link";
import { InfoTip } from "@/components/info-tip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarList, DailyBars, StageFunnel, StatCard, type DayBar } from "@/components/charts";
import { LIFECYCLE, type LifecycleState } from "@/lib/lifecycle";
import { STATUS_LABEL } from "@/lib/account-filters";
import { createClient, currentUser, isPrivileged } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const WINDOWS = [7, 30, 90];

/**
 * Reports.
 *
 * Everything here is a rollup of the same three facts the rest of the system
 * runs on: who holds what, how close it is to being lost, and whether anybody
 * called. There is no separate reporting store and no nightly job — the numbers
 * come from the live tables through the same row level security as the screens
 * that produced them, so a report can never show a rep a book they cannot open.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: rawDays } = await searchParams;
  const days = WINDOWS.includes(Number(rawDays)) ? Number(rawDays) : 30;

  const supabase = await createClient();
  const me = await currentUser();
  if (!me) return null;

  const managerish = me.role === "manager" || isPrivileged(me.role);
  const scope = managerish ? "team" : "mine";

  const [boardRes, branchRes, mixRes, industryRes, funnelRes, dailyRes] = await Promise.all([
    supabase.rpc("dashboard_leaderboard", { p_days: days }),
    supabase.rpc("dashboard_by_branch", { p_days: days }),
    supabase.rpc("dashboard_state_mix", { p_scope: scope }),
    supabase.rpc("dashboard_industry_mix", { p_scope: scope, p_limit: 12 }),
    supabase.rpc("dashboard_stage_funnel", { p_scope: scope }),
    supabase.rpc("dashboard_calls_daily", { p_days: days, p_scope: scope }),
  ]);

  const board = (boardRes.data ?? []) as LeaderRow[];
  const branches = (branchRes.data ?? []) as BranchRow[];
  const mix = (mixRes.data ?? []) as { bucket: string; kind: string; accounts: number }[];
  const industries = (industryRes.data ?? []) as {
    industry: string;
    accounts: number;
    customers: number;
    at_risk: number;
  }[];
  const funnel = ((funnelRes.data ?? []) as { stage: string; accounts: number }[]).map((r) => ({
    stage: r.stage,
    accounts: Number(r.accounts),
  }));
  const daily = ((dailyRes.data ?? []) as { day: string; calls: number; qualifying: number }[]).map(
    (d): DayBar => ({ day: d.day, calls: Number(d.calls), qualifying: Number(d.qualifying) }),
  );

  const totalCalls = board.reduce((s, r) => s + Number(r.calls), 0);
  const totalQualifying = board.reduce((s, r) => s + Number(r.qualifying), 0);
  const totalOwned = board.reduce((s, r) => s + Number(r.owned), 0);
  const totalAtRisk = board.reduce((s, r) => s + Number(r.at_risk), 0);

  const clock = mix.filter((m) => m.kind === "clock");
  const status = mix.filter((m) => m.kind === "status");

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">Reports<InfoTip k="reportsScreen" side="bottom" /></h1>
          <p className="text-sm text-muted-foreground">
            {managerish ? "Your whole reporting line." : "Your own numbers."} Live from the same
            tables the screens read.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border bg-card p-0.5">
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={`/reports?days=${w}`}
              data-active={w === days}
              className="rounded px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent data-[active=true]:bg-navy-700 data-[active=true]:text-white"
            >
              {w} days
            </Link>
          ))}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Accounts held" value={totalOwned.toLocaleString()} />
        <StatCard
          label="At risk"
          value={totalAtRisk.toLocaleString()}
          tone={totalAtRisk > 0 ? "warning" : "good"}
          hint={totalOwned > 0 ? `${Math.round((totalAtRisk / totalOwned) * 100)}% of the book` : undefined}
        />
        <StatCard label={`Calls, ${days} days`} value={totalCalls.toLocaleString()} />
        <StatCard
          label="Counted"
          value={totalCalls === 0 ? "—" : `${Math.round((totalQualifying / totalCalls) * 100)}%`}
          hint={`${totalQualifying.toLocaleString()} of ${totalCalls.toLocaleString()}`}
          tone={totalCalls > 0 && totalQualifying / totalCalls < 0.4 ? "warning" : "default"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calling, last {days} days</CardTitle>
          <p className="text-xs text-muted-foreground">
            Green is the part that counted. The gap between the two is the prospecting policy in
            one picture.
          </p>
        </CardHeader>
        <CardContent>
          <DailyBars data={daily} />
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------------
          Leaderboard, ranked by qualifying calls rather than calls made.
         --------------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">By rep<InfoTip k="leaderboard" side="bottom" /></CardTitle>
          <p className="text-xs text-muted-foreground">
            Ranked by calls that counted, not calls dialled.
          </p>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-6 py-2 font-medium">Rep</th>
                  <th className="px-3 py-2 text-right font-medium">Held</th>
                  <th className="px-3 py-2 text-right font-medium">At risk</th>
                  <th className="px-3 py-2 text-right font-medium">Customers</th>
                  <th className="px-3 py-2 text-right font-medium">Calls</th>
                  <th className="px-3 py-2 text-right font-medium">Counted</th>
                  <th className="px-6 py-2 text-right font-medium">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                {board.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground">
                      Nobody in scope yet.
                    </td>
                  </tr>
                ) : (
                  board.map((r) => {
                    const over = r.prospect_limit !== null && Number(r.owned) > r.prospect_limit;
                    const isMe = r.user_id === me.id;
                    return (
                      <tr
                        key={r.user_id}
                        data-me={isMe}
                        className="border-b last:border-b-0 hover:bg-accent/40 data-[me=true]:bg-navy-50 dark:data-[me=true]:bg-navy-900/50"
                      >
                        <td className="px-6 py-2.5">
                          <Link href={`/accounts?owner=${r.user_id}`} className="font-medium hover:underline">
                            {r.full_name}
                          </Link>
                          {isMe ? (
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              you
                            </span>
                          ) : null}
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
                        <td className="px-6 py-2.5 text-right tabular-nums">
                          {r.connected_rate === null ? (
                            <span className="text-muted-foreground">no calls</span>
                          ) : (
                            `${r.connected_rate}%`
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">By branch<InfoTip k="byBranch" side="bottom" /></CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-6 py-2 font-medium">Branch</th>
                  <th className="px-3 py-2 text-right font-medium">Reps</th>
                  <th className="px-3 py-2 text-right font-medium">Held</th>
                  <th className="px-3 py-2 text-right font-medium">At risk</th>
                  <th className="px-6 py-2 text-right font-medium">Counted</th>
                </tr>
              </thead>
              <tbody>
                {branches.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                      No branches in scope.
                    </td>
                  </tr>
                ) : (
                  branches.map((b) => (
                    <tr key={b.location} className="border-b last:border-b-0 hover:bg-accent/40">
                      <td className="px-6 py-2.5 font-medium">
                        <Link href={`/accounts?loc=${encodeURIComponent(b.location)}`} className="hover:underline">
                          {b.location}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{b.reps}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{b.owned}</td>
                      <td
                        className={`px-3 py-2.5 text-right tabular-nums ${
                          Number(b.at_risk) > 0 ? "text-destructive" : ""
                        }`}
                      >
                        {b.at_risk}
                      </td>
                      <td className="px-6 py-2.5 text-right tabular-nums text-brand-600">
                        {b.qualifying}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">Pipeline by stage<InfoTip k="stageFunnel" side="bottom" /></CardTitle>
          </CardHeader>
          <CardContent>
            <StageFunnel rows={funnel} hrefBase="/accounts?stage=" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">Where the clock stands<InfoTip k="clockDistribution" side="bottom" /></CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              rows={clock.map((c) => ({
                label: LIFECYCLE[c.bucket as LifecycleState]?.label ?? c.bucket,
                value: Number(c.accounts),
                href: `/accounts?state=${c.bucket}`,
              }))}
              empty="No accounts in scope."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">By status<InfoTip k="statusMix" side="bottom" /></CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              rows={status.map((s) => ({
                label: STATUS_LABEL[s.bucket] ?? s.bucket,
                value: Number(s.accounts),
                href: `/accounts?status=${s.bucket}`,
              }))}
              empty="No accounts in scope."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">Industry<InfoTip k="industryMix" side="bottom" /></CardTitle>
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
              empty="No industries recorded."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface LeaderRow {
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
  connected_rate: number | null;
}

interface BranchRow {
  location: string;
  reps: number;
  owned: number;
  at_risk: number;
  customers: number;
  calls: number;
  qualifying: number;
}
