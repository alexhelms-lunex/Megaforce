import Link from "next/link";
import { AlertTriangle, Clock, ShieldCheck, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import type { CurrentUser } from "@/lib/supabase/server";

/**
 * What Customer Credit opens in the morning.
 *
 * ---------------------------------------------------------------------------
 * Credit had the sales dashboard: pipeline, call volume, stage funnel,
 * conversion rate. Every number on it was about work they do not do. They hold
 * no book, they make no calls, and their conversion rate is structurally zero.
 *
 * Alex, on what belongs here: "For customer credit the main focus is credit
 * increase requests and setting up credit."
 *
 * So the screen is a queue, and the queue is the point. Two numbers lead --
 * what is waiting, and how long the oldest has waited -- because those are the
 * two a credit function is judged on and neither existed anywhere before.
 *
 * The second panel is the half nobody asks for: customers being shipped for
 * with no limit agreed at all. No request is ever raised for those, so they
 * appear in no queue, and they stay invisible until one of them is a bad debt.
 * ---------------------------------------------------------------------------
 */

interface CreditKpis {
  pending_credit: number;
  pending_credit_value: number;
  oldest_pending_days: number;
  decided_30d: number;
  approved_30d: number;
  duplicates_open: number;
  customers_without_limit: number;
  total_exposure: number;
  accounts_at_limit: number;
}

interface QueueRow {
  request_id: string;
  account_id: string;
  account_name: string;
  billing_city: string | null;
  billing_state: string | null;
  current_limit: number | null;
  requested_amount: number | null;
  reason: string | null;
  requested_by_name: string | null;
  owner_name: string | null;
  waiting_days: number;
}

interface GapRow {
  account_id: string;
  account_name: string;
  billing_city: string | null;
  billing_state: string | null;
  owner_name: string | null;
  activity_90d: number;
}

const ZERO: CreditKpis = {
  pending_credit: 0,
  pending_credit_value: 0,
  oldest_pending_days: 0,
  decided_30d: 0,
  approved_30d: 0,
  duplicates_open: 0,
  customers_without_limit: 0,
  total_exposure: 0,
  accounts_at_limit: 0,
};

export async function CreditDashboard({ me }: { me: CurrentUser }) {
  const supabase = await createClient();

  const [kpiRes, queueRes, gapsRes, dupesRes] = await Promise.all([
    supabase.rpc("dashboard_credit"),
    supabase.rpc("credit_queue", { p_limit: 12 }),
    supabase.rpc("credit_gaps", { p_limit: 10 }),
    supabase
      .from("accounts")
      .select("id, name, billing_city, billing_state")
      .eq("locked_to_credit", true)
      .limit(8),
  ]);

  const k: CreditKpis = { ...ZERO, ...((kpiRes.data as CreditKpis[] | null)?.[0] ?? {}) };
  const queue = (queueRes.data ?? []) as QueueRow[];
  const gaps = (gapsRes.data ?? []) as GapRow[];
  const dupes = (dupesRes.data ?? []) as { id: string; name: string; billing_city: string | null; billing_state: string | null }[];

  // A queue that cannot be read is not an empty queue, and the difference is a
  // migration nobody has run.
  const failure = kpiRes.error?.message ?? queueRes.error?.message ?? null;

  const approvalRate =
    k.decided_30d === 0 ? null : Math.round((k.approved_30d / k.decided_30d) * 100);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting()}, {me.full_name.split(" ")[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          Credit limits waiting on you, and the customers who have none.
        </p>
      </header>

      {failure ? (
        <Card size="sm">
          <CardContent className="text-sm">
            <p className="font-medium">The credit queue is not available yet.</p>
            <p className="mt-1 text-muted-foreground">
              An administrator needs to apply the latest database changes from the setup page.
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{failure}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={<ShieldCheck className="size-4" aria-hidden />}
          label="Waiting on you"
          value={k.pending_credit.toLocaleString()}
          detail={
            k.pending_credit > 0
              ? `${formatMoney(k.pending_credit_value)} of limit requested`
              : "Nothing in the queue"
          }
          tone={k.pending_credit > 0 ? "attention" : "calm"}
          help="Credit limit requests raised by brokers and managers that nobody has decided yet. Only you and an admin can decide these — a manager cannot approve their own broker's limit."
        />
        <Kpi
          icon={<Clock className="size-4" aria-hidden />}
          label="Longest wait"
          value={k.oldest_pending_days > 0 ? `${k.oldest_pending_days}d` : "—"}
          detail={
            k.oldest_pending_days >= 5
              ? "Somebody's deal is blocked on this"
              : "Within a working week"
          }
          tone={k.oldest_pending_days >= 5 ? "urgent" : "calm"}
          help="How long the oldest undecided request has been sitting. A broker cannot quote without a limit, so this number is somebody's stalled deal."
        />
        <Kpi
          icon={<AlertTriangle className="size-4" aria-hidden />}
          label="Customers with no limit"
          value={k.customers_without_limit.toLocaleString()}
          detail="Being shipped for with nothing agreed"
          tone={k.customers_without_limit > 0 ? "attention" : "calm"}
          help="Accounts marked as customers that have no credit limit on file. Nobody raises a request for these, so they appear in no queue — which is exactly why they are worth a number of their own."
        />
        <Kpi
          icon={<TrendingUp className="size-4" aria-hidden />}
          label="Total exposure"
          value={formatMoney(k.total_exposure)}
          detail={
            approvalRate === null
              ? "No decisions in 30 days"
              : `${approvalRate}% approved, last 30 days`
          }
          tone="calm"
          help="Every credit limit on file, added up. It is the ceiling the company has agreed to, not what is currently owed."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              Credit requests
              <InfoTip text="Oldest first, because this is a work queue. Open one to see the account, the reason and what limit was asked for." />
            </CardTitle>
            <Link href="/requests" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
              All requests →
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {queue.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                Nothing waiting. Everything raised has been decided.
              </p>
            ) : (
              <ul className="divide-y">
                {queue.map((row) => (
                  <li key={row.request_id}>
                    <Link
                      href={`/accounts/${row.account_id}?tab=requests`}
                      className="block px-6 py-3 transition-colors hover:bg-accent/40"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">{row.account_name}</span>
                        <span className="text-xs text-muted-foreground">
                          {[row.billing_city, row.billing_state].filter(Boolean).join(", ")}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          <span className="text-sm tabular-nums text-muted-foreground">
                            {row.current_limit ? formatMoney(row.current_limit) : "none"}
                          </span>
                          <span aria-hidden className="text-muted-foreground">→</span>
                          <span className="text-sm font-semibold tabular-nums">
                            {row.requested_amount ? formatMoney(row.requested_amount) : "—"}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${
                              row.waiting_days >= 5
                                ? "border-red-300 bg-red-100 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                                : "border-border bg-muted/60 text-muted-foreground"
                            }`}
                          >
                            {row.waiting_days}d
                          </span>
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">
                        {row.requested_by_name ? `${row.requested_by_name}: ` : ""}
                        {row.reason ?? "No reason given"}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                No limit agreed
                <InfoTip text="Customers with no credit limit on file. Nobody raises a request for these — they simply became customers and nothing was set." />
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {gaps.length === 0 ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  Every customer has a limit.
                </p>
              ) : (
                <ul className="divide-y">
                  {gaps.map((row) => (
                    <li key={row.account_id}>
                      <Link
                        href={`/accounts/${row.account_id}?tab=credit`}
                        className="block px-6 py-2.5 transition-colors hover:bg-accent/40"
                      >
                        <p className="truncate text-sm font-medium">{row.account_name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {row.owner_name ?? "unowned"} ·{" "}
                          {Number(row.activity_90d).toLocaleString()} activities in 90 days
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                Possible duplicates
                <InfoTip text="Accounts flagged as matching an existing record. They are held here rather than in a broker's book until you decide which is real." />
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {dupes.length === 0 ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  Nothing flagged.
                </p>
              ) : (
                <ul className="divide-y">
                  {dupes.map((row) => (
                    <li key={row.id}>
                      <Link
                        href={`/accounts/${row.id}`}
                        className="block px-6 py-2.5 transition-colors hover:bg-accent/40"
                      >
                        <p className="truncate text-sm font-medium">{row.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[row.billing_city, row.billing_state].filter(Boolean).join(", ") || "—"}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  detail,
  tone,
  help,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "calm" | "attention" | "urgent";
  help: string;
}) {
  const ring =
    tone === "urgent"
      ? "border-red-300 dark:border-red-900"
      : tone === "attention"
        ? "border-amber-300 dark:border-amber-900"
        : "border-border/60";

  return (
    <div className={`rounded-2xl border bg-card p-5 ${ring}`}>
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        <InfoTip text={help} />
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
