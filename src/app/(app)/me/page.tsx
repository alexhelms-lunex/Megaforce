import Link from "next/link";
import { AlertTriangle, Building2, PhoneCall, Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarList, DailyBars, StatCard, type DayBar } from "@/components/charts";
import { LifecycleFlag } from "@/components/lifecycle-flag";
import { LIFECYCLE, type LifecycleState } from "@/lib/lifecycle";
import { createClient, currentUser } from "@/lib/supabase/server";
import { daysSince } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The tiers from the prospecting policy.
 *
 * Junior (0–12 months) is 200 and Unseasoned (2–3 years) is 100. That reads
 * like a transposition and is not: a new broker is building a book from nothing
 * and needs the width, while a rep two years in is expected to be converting
 * what they already hold. Confirmed against the policy — it is not a bug.
 */
function tierFor(startDate: string | null, role: string): { name: string; limit: number } {
  if (role === "manager") return { name: "National Account Director", limit: 250 };
  if (!startDate) return { name: "Unset", limit: 100 };
  const months = (Date.now() - new Date(startDate).getTime()) / (30.44 * 86_400_000);
  if (months < 12) return { name: "Junior (under a year)", limit: 200 };
  if (months < 36) return { name: "Unseasoned (1–3 years)", limit: 100 };
  return { name: "Veteran (3 years and up)", limit: 100 };
}

/**
 * My book.
 *
 * A rep's own page: what they hold, what their tier allows, and what is about
 * to be taken off them. It exists because the limit is a real rule with a real
 * consequence, and a rule nobody can see the current state of is a rule that
 * gets enforced by surprise.
 */
export default async function MyBookPage() {
  const supabase = await createClient();
  const me = await currentUser();
  if (!me) return null;

  const [kpiRes, dailyRes, bookRes, mixRes] = await Promise.all([
    supabase.rpc("dashboard_kpis", { p_scope: "mine" }),
    supabase.rpc("dashboard_calls_daily", { p_days: 30, p_scope: "mine" }),
    supabase
      .from("accounts_with_state")
      .select("id, name, status, stage, state, days_left, last_activity_at, billing_city, billing_state")
      .eq("owner_id", me.id)
      .order("urgency", { ascending: true })
      .order("days_left", { ascending: true, nullsFirst: false })
      .limit(300),
    supabase.rpc("dashboard_industry_mix", { p_scope: "mine", p_limit: 10 }),
  ]);

  const kpis = ((kpiRes.data as Record<string, number>[] | null)?.[0] ?? {}) as {
    owned?: number;
    prospects?: number;
    customers?: number;
    at_risk?: number;
    calls_7d?: number;
    qualifying_7d?: number;
    unlogged?: number;
    contacts_owned?: number;
  };

  const daily = ((dailyRes.data ?? []) as { day: string; calls: number; qualifying: number }[]).map(
    (d): DayBar => ({ day: d.day, calls: Number(d.calls), qualifying: Number(d.qualifying) }),
  );

  type BookRow = {
    id: string;
    name: string;
    status: string;
    stage: string;
    state: LifecycleState;
    days_left: number | null;
    last_activity_at: string | null;
    billing_city: string | null;
    billing_state: string | null;
  };
  const book = (bookRes.data ?? []) as BookRow[];
  const industries = (industriesOf(mixRes.data));

  const tier = tierFor(me.start_date, me.role);
  const limit = me.prospect_limit ?? tier.limit;
  const owned = Number(kpis.owned ?? book.length);
  const pct = limit > 0 ? Math.min(100, Math.round((owned / limit) * 100)) : 0;
  const over = owned > limit;

  const byState = new Map<string, number>();
  for (const row of book) byState.set(row.state, (byState.get(row.state) ?? 0) + 1);

  const calls7 = Number(kpis.calls_7d ?? 0);
  const qual7 = Number(kpis.qualifying_7d ?? 0);

  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <header className="overflow-hidden rounded-xl border bg-card">
        <div className="brand-gradient px-6 py-5 text-white">
          <h1 className="text-2xl font-semibold tracking-tight">{me.full_name}</h1>
          <p className="text-sm text-white/75">
            {[tier.name, me.location, me.start_date ? `started ${me.start_date}` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        {/* ------------------------------------------------------------------
            The limit, as a bar rather than a number.
            "182 of 200" is a fact; a bar three-quarters full is a feeling, and
            the feeling is what stops somebody claiming their 201st prospect.
           ------------------------------------------------------------------ */}
        <div className="space-y-2 px-6 py-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium">Prospect limit</p>
            <p className="text-sm tabular-nums">
              <span className={over ? "font-bold text-destructive" : "font-semibold"}>{owned}</span>
              <span className="text-muted-foreground"> of {limit}</span>
            </p>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${
                over ? "bg-destructive" : pct > 85 ? "bg-amber-500" : "bg-brand-400"
              }`}
              style={{ width: `${Math.max(pct, 2)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {over
              ? `You are ${owned - limit} over your tier's cap. Release something, or ask for an exception on a company's Requests tab.`
              : `${limit - owned} more before you hit your tier's cap.`}
          </p>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Accounts held"
          value={owned}
          icon={Building2}
          href="/accounts?mine=1"
          hint={`${kpis.prospects ?? 0} prospects · ${kpis.customers ?? 0} customers`}
        />
        <StatCard
          label="Needs attention"
          value={Number(kpis.at_risk ?? 0)}
          icon={AlertTriangle}
          href="/accounts?preset=at-risk"
          tone={Number(kpis.at_risk ?? 0) > 0 ? "warning" : "good"}
        />
        <StatCard
          label="Calls, last 7 days"
          value={calls7}
          icon={PhoneCall}
          href="/activity?mine=1"
          hint={`${qual7} counted`}
        />
        <StatCard
          label="Contacts on your accounts"
          value={Number(kpis.contacts_owned ?? 0)}
          icon={Target}
          href="/contacts"
          hint="an email only counts if it went to one of these"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Your calling, last 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyBars data={daily} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your book by clock</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              rows={[...byState.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([state, n]) => ({
                  label: LIFECYCLE[state as LifecycleState]?.label ?? state,
                  value: n,
                  href: `/accounts?mine=1&state=${state}`,
                }))}
              empty="You hold nothing yet."
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Closest to being taken</CardTitle>
            <Link href="/accounts?preset=at-risk" className="text-xs font-medium text-primary hover:underline">
              See all
            </Link>
          </CardHeader>
          <CardContent>
            {book.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                You hold nothing yet.{" "}
                <Link href="/available" className="text-primary hover:underline">
                  Claim something from the pool.
                </Link>
              </p>
            ) : (
              <ul className="divide-y">
                {book.slice(0, 10).map((row) => {
                  const idle = daysSince(row.last_activity_at);
                  return (
                    <li key={row.id}>
                      <Link
                        href={`/accounts/${row.id}`}
                        className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{row.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[
                              row.billing_city && row.billing_state
                                ? `${row.billing_city}, ${row.billing_state}`
                                : null,
                              row.stage,
                              idle === null ? "never worked" : `${idle}d quiet`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
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
            <CardTitle className="text-base">Your industries</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              highlightLabel="customers"
              rows={industries.map((i) => ({
                label: i.industry,
                value: Number(i.accounts),
                highlight: Number(i.customers),
                href: `/accounts?mine=1&industry=${encodeURIComponent(i.industry)}`,
              }))}
              empty="No industries recorded on your accounts."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function industriesOf(
  data: unknown,
): { industry: string; accounts: number; customers: number }[] {
  return (data ?? []) as { industry: string; accounts: number; customers: number }[];
}
