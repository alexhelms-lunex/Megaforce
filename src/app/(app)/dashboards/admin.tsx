import Link from "next/link";
import {
  Building2,
  ClipboardCheck,
  Inbox,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { Greeting } from "@/components/greeting";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import type { CurrentUser } from "@/lib/supabase/server";

/**
 * The whole company, on one screen.
 *
 * ---------------------------------------------------------------------------
 * Alex, on what an administrator needs: "For Administrative its visibility into
 * everything."
 *
 * The distinction that makes this screen different from every other dashboard
 * is that an admin is not working a book. They are answering three questions,
 * and none of them is a sales question:
 *
 *   Is the system doing its job?   -- the clock releasing, calls being matched
 *   Is anybody blocked?            -- queues nobody is clearing
 *   Is anything drifting?          -- people with no login, accounts with no owner
 *
 * So every tile here links to the queue behind it. A number an admin cannot act
 * on is a number that trains them to ignore the screen.
 * ---------------------------------------------------------------------------
 */

interface Counts {
  bucket: string;
  n: number;
}

export async function AdminDashboard({ me }: { me: CurrentUser }) {
  const supabase = await createClient();

  // The sweep first and awaited, exactly as the sales dashboard does it: the
  // figures below are about whether the clock is working, so reading them
  // before it has run would report a backlog this page just caused.
  await supabase.rpc("sweep_if_due", { p_max_age_minutes: 15 });

  const [userCounts, dirCounts, creditRes, reviewRes, requestsRes, unloggedRes, riskRes, staleRes] =
    await Promise.all([
      supabase.rpc("admin_user_counts"),
      supabase.rpc("account_directory_counts"),
      supabase.rpc("dashboard_credit"),
      supabase
        .from("unmatched_activities")
        .select("id", { count: "exact", head: true })
        .is("resolved_at", null),
      supabase
        .from("account_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase
        .from("activities")
        .select("id", { count: "exact", head: true })
        .eq("type", "call")
        .is("logged_at", null),
      supabase
        .from("accounts_with_state")
        .select("id", { count: "exact", head: true })
        .in("state", ["overdue", "expiring"]),
      supabase
        .from("accounts_with_state")
        .select("id, name, owner_name, state, days_left, billing_city, billing_state")
        .eq("state", "overdue")
        .order("days_left", { ascending: true, nullsFirst: true })
        .limit(10),
    ]);

  const users = new Map(
    ((userCounts.data ?? []) as Counts[]).map((r) => [r.bucket, Number(r.n)]),
  );
  const dir = ((dirCounts.data ?? []) as Record<string, number>[])[0] ?? {};
  const credit = ((creditRes.data ?? []) as Record<string, number>[])[0] ?? {};
  const overdue = (staleRes.data ?? []) as {
    id: string;
    name: string;
    owner_name: string | null;
    days_left: number | null;
    billing_city: string | null;
    billing_state: string | null;
  }[];

  const noLogin = users.get("nologin") ?? 0;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          <Greeting name={me.full_name.split(" ")[0]} />
        </h1>
        <p className="text-sm text-muted-foreground">
          The whole company: what is queued, what is drifting, and whether the rules are running.
        </p>
      </header>

      {/* Queues first. These are the things where somebody else is blocked and
          nobody has told anybody. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Waiting on somebody
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            href="/requests"
            icon={<ShieldCheck className="size-4" aria-hidden />}
            label="Open requests"
            value={requestsRes.count ?? 0}
            help="Amnesty, extensions, transfers, national promotions and credit limits that nobody has decided. A request nobody decides is a broker who stops raising them."
          />
          <Tile
            href="/requests?kind=credit"
            icon={<ShieldCheck className="size-4" aria-hidden />}
            label="Credit limits"
            value={Number(credit.pending_credit ?? 0)}
            detail={
              Number(credit.oldest_pending_days ?? 0) > 0
                ? `oldest ${Number(credit.oldest_pending_days)}d`
                : undefined
            }
            urgent={Number(credit.oldest_pending_days ?? 0) >= 5}
            help="Credit limit requests waiting on Customer Credit. A broker cannot quote without a limit, so each of these is a stalled deal."
          />
          <Tile
            href="/review"
            icon={<ClipboardCheck className="size-4" aria-hidden />}
            label="Unmatched calls"
            value={reviewRes.count ?? 0}
            help="Calls the matcher could not attribute to one company — usually a shared switchboard or a number on file at two accounts. Until somebody resolves them they count for nobody."
          />
          <Tile
            href="/activity?unlogged=1"
            icon={<Inbox className="size-4" aria-hidden />}
            label="Calls not written up"
            value={unloggedRes.count ?? 0}
            help="Captured calls with no contact, notes or stage. An unwritten call is not an approved activity, so the account keeps running down its clock as though the call never happened."
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          The book
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            href="/prospects"
            icon={<Building2 className="size-4" aria-hidden />}
            label="Companies"
            value={Number(dir.total ?? 0)}
            detail={`${Number(dir.available ?? 0).toLocaleString()} unclaimed`}
            help="Every company on file. The unclaimed figure is the available pool — accounts nobody holds, which any broker can take."
          />
          <Tile
            href="/accounts?preset=expiring"
            icon={<TriangleAlert className="size-4" aria-hidden />}
            label="About to be lost"
            value={riskRes.count ?? 0}
            urgent={(riskRes.count ?? 0) > 0}
            help="Accounts in the amber or red band. Each is a holder who has not logged an approved activity recently enough, and each will return to the pool on its own if that does not change."
          />
          <Tile
            href="/admin/users"
            icon={<Users className="size-4" aria-hidden />}
            label="People"
            value={users.get("active") ?? 0}
            detail={noLogin > 0 ? `${noLogin} with no login` : "all can sign in"}
            urgent={noLogin > 0}
            help="Active people in the CRM. Anybody with no login exists as a person — ownable and countable — but cannot sign in yet."
          />
          <Tile
            href="/reports"
            icon={<Building2 className="size-4" aria-hidden />}
            label="Credit exposure"
            value={formatMoney(Number(credit.total_exposure ?? 0))}
            detail={
              Number(credit.customers_without_limit ?? 0) > 0
                ? `${Number(credit.customers_without_limit)} customers with none`
                : "every customer has a limit"
            }
            urgent={Number(credit.customers_without_limit ?? 0) > 0}
            help="Every credit limit on file added together — the ceiling the company has agreed to, not what is owed today."
            raw
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              Past the deadline and still held
              <InfoTip text="These should have returned to the pool. If this list is not empty and not shrinking, the release sweep is not running — check the cron on the Admin screen." />
            </CardTitle>
            <Link href="/accounts?preset=expiring" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
              All →
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {overdue.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                Nothing overdue. The clock is doing its job.
              </p>
            ) : (
              <ul className="divide-y">
                {overdue.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/accounts/${row.id}`}
                      className="flex items-center gap-3 px-6 py-2.5 transition-colors hover:bg-accent/40"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {row.owner_name ?? "unowned"}
                      </span>
                      <span className="rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-medium tabular-nums text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                        {row.days_left ?? 0}d
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where to go</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <Shortcut href="/admin/users" label="People and roles" detail="Add, deactivate, change what somebody can do" />
            <Shortcut href="/admin" label="Rules and integrations" detail="The clock, qualification, RingCentral, the cron" />
            <Shortcut href="/admin/roles" label="What each role can do" detail="The capability matrix, as data rather than a paragraph" />
            <Shortcut href="/prospects" label="Prospects" detail="Every company, whoever holds it" />
            <Shortcut href="/reports" label="Reports" detail="Calls, approvals, claims and losses over time" />
            <Shortcut href="/api/health" label="Server timings" detail="How long each database round trip takes" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Tile({
  href,
  icon,
  label,
  value,
  detail,
  urgent,
  help,
  raw,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  value: number | string;
  detail?: string;
  urgent?: boolean;
  help: string;
  raw?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-2xl border bg-card p-5 transition-colors hover:bg-accent/30 ${
        urgent ? "border-amber-300 dark:border-amber-900" : "border-border/60"
      }`}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        <InfoTip text={help} />
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">
        {raw ? value : Number(value).toLocaleString()}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{detail ?? " "}</p>
    </Link>
  );
}

function Shortcut({ href, label, detail }: { href: string; label: string; detail: string }) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-border/60 px-4 py-3 transition-colors hover:bg-accent/40"
    >
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </Link>
  );
}

