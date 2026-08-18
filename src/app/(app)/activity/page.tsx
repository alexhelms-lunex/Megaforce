import Link from "next/link";
import { InfoTip } from "@/components/info-tip";
import { CheckCircle2, CircleSlash } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/charts";
import { ActivityRow, FeedViewTabs, type FeedView } from "@/components/activity-row";
import { createClient, currentUser, isPrivileged } from "@/lib/supabase/server";
import { loadPreferences } from "@/lib/prefs-server";
import { resolvePageSize } from "@/lib/preferences";

export const dynamic = "force-dynamic";

const FILTERS: { param: string; label: string; options: { value: string; label: string }[] }[] = [
  {
    param: "type",
    label: "Any type",
    options: [
      { value: "call", label: "Calls" },
      { value: "email", label: "Emails" },
      { value: "meeting", label: "Meetings" },
      { value: "note", label: "Notes" },
    ],
  },
  {
    param: "dir",
    label: "Any direction",
    options: [
      { value: "outbound", label: "Outbound" },
      { value: "inbound", label: "Inbound" },
    ],
  },
  {
    param: "counted",
    label: "Counted or not",
    options: [
      { value: "yes", label: "Counted toward the clock" },
      { value: "no", label: "Did not count" },
    ],
  },
  {
    param: "logged",
    label: "Written up or not",
    options: [
      { value: "no", label: "Not written up" },
      { value: "yes", label: "Written up" },
    ],
  },
  {
    param: "days",
    label: "All time",
    options: [
      { value: "1", label: "Today" },
      { value: "7", label: "Last 7 days" },
      { value: "30", label: "Last 30 days" },
      { value: "90", label: "Last 90 days" },
    ],
  },
];

/**
 * Everything that has happened, and whether it counted.
 *
 * The dock shows a broker their own unlogged calls. This screen is the wider
 * view: every activity the caller can see, filterable, with the qualification
 * reason on each row. It is where a manager answers "is this rep actually
 * calling", and where a broker finds the six calls from last Thursday they
 * never wrote up.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const get = (k: string) => {
    const v = raw[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const supabase = await createClient();
  const me = await currentUser();
  if (!me) return null;

  const mine = get("mine") === "1" || (!get("owner") && !isPrivileged(me.role) && me.role !== "manager");
  const page = Math.max(1, Number.parseInt(get("page") || "1", 10) || 1);
  const view: FeedView = get("view") === "system" ? "system" : "notes";
  const prefs = await loadPreferences().catch(() => null);
  const PAGE_SIZE = resolvePageSize(get("per") || undefined, prefs?.rows_per_page);
  const from = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("activities")
    .select(
      "id, type, direction, subject, occurred_at, duration_seconds, result, source, " +
        "qualifies, qualification_reason, stage_outcome, notes, logged_at, user_id, account_id, " +
        "accounts(name), users!activities_user_id_fkey(full_name)",
      { count: "exact" },
    )
    .order("occurred_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (get("type")) query = query.eq("type", get("type"));
  if (get("dir")) query = query.eq("direction", get("dir"));
  if (get("counted")) query = query.eq("qualifies", get("counted") === "yes");
  if (get("logged") === "no") query = query.is("logged_at", null);
  if (get("logged") === "yes") query = query.not("logged_at", "is", null);
  if (get("owner")) query = query.eq("user_id", get("owner"));
  if (mine) query = query.eq("user_id", me.id);
  if (get("days")) {
    const days = Number.parseInt(get("days"), 10);
    if (Number.isFinite(days)) {
      query = query.gte("occurred_at", new Date(Date.now() - days * 86_400_000).toISOString());
    }
  }

  const { data, count, error } = await query;
  if (error) {
    return <p className="text-sm text-destructive">Could not load activity: {error.message}</p>;
  }

  type Row = {
    id: string;
    type: string;
    direction: string | null;
    subject: string | null;
    occurred_at: string;
    duration_seconds: number | null;
    result: string | null;
    source: string;
    qualifies: boolean;
    qualification_reason: string;
    stage_outcome: string | null;
    notes: string | null;
    logged_at: string | null;
    account_id: string | null;
    accounts: { name: string } | { name: string }[] | null;
    users: { full_name: string } | { full_name: string }[] | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const total = count ?? rows.length;

  // Counted over the rows on screen, so the numbers always agree with the list
  // beneath them. A summary computed over a different set than the one shown is
  // how a screen starts arguing with itself.
  const counted = rows.filter((r) => r.qualifies).length;
  const unlogged = rows.filter((r) => r.type === "call" && !r.logged_at).length;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">Activity<InfoTip k="activityFeed" side="bottom" /></h1>
        <p className="text-sm text-muted-foreground">
          Every call, email and meeting you can see — and whether it reset an account&apos;s clock.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="On this page" value={rows.length} hint={`${total.toLocaleString()} total`} />
        <StatCard
          label="Counted"
          value={counted}
          icon={CheckCircle2}
          tone={counted > 0 ? "good" : "default"}
          hint={rows.length > 0 ? `${Math.round((counted / rows.length) * 100)}% of this page` : undefined}
        />
        <StatCard
          label="Calls not written up"
          value={unlogged}
          icon={CircleSlash}
          tone={unlogged > 0 ? "warning" : "default"}
          hint={unlogged > 0 ? "open the dock, bottom left" : "nothing outstanding"}
        />
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        {FILTERS.map((f) => (
          <select
            key={f.param}
            name={f.param}
            defaultValue={get(f.param)}
            data-set={get(f.param) !== ""}
            className="h-9 rounded-md border bg-background px-2 text-sm data-[set=true]:border-navy-500 data-[set=true]:bg-navy-50 data-[set=true]:font-medium dark:data-[set=true]:bg-navy-900"
          >
            <option value="">{f.label}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
          <input type="checkbox" name="mine" value="1" defaultChecked={mine} className="size-3.5 accent-navy-700" />
          Only mine
        </label>
        <button className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">
          Apply
        </button>
        <Link
          href="/activity"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-accent"
        >
          Reset
        </Link>
      </form>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {total.toLocaleString()} {total === 1 ? "activity" : "activities"}
          </CardTitle>
          <div className="flex items-center gap-3">
            {/* Alex: the note is what we see first; the machine's reasoning
                lives behind the second tab. */}
            <FeedViewTabs
              view={view}
              hrefFor={(v) => {
                const next = new URLSearchParams();
                for (const [k, val] of Object.entries(raw)) {
                  const one = Array.isArray(val) ? val[0] : val;
                  if (one && k !== "view") next.set(k, one);
                }
                if (v !== "notes") next.set("view", v);
                const qs = next.toString();
                return qs ? `/activity?${qs}` : "/activity";
              }}
            />
          {total > PAGE_SIZE ? (
            <div className="flex items-center gap-1 text-xs">
              <PageLink raw={raw} page={page - 1} disabled={page <= 1}>
                Previous
              </PageLink>
              <span className="px-2 tabular-nums text-muted-foreground">
                {page} / {lastPage}
              </span>
              <PageLink raw={raw} page={page + 1} disabled={page >= lastPage}>
                Next
              </PageLink>
            </div>
          ) : null}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Nothing matches those filters.
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <ActivityRow
                  key={r.id}
                  view={view}
                  activity={{
                    ...r,
                    accountName: (Array.isArray(r.accounts) ? r.accounts[0] : r.accounts)?.name ?? null,
                    userName: (Array.isArray(r.users) ? r.users[0] : r.users)?.full_name ?? null,
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PageLink({
  raw,
  page,
  disabled,
  children,
}: {
  raw: Record<string, string | string[] | undefined>;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="inline-flex h-8 items-center rounded-md border px-3 text-muted-foreground/50">
        {children}
      </span>
    );
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s && k !== "page") params.set(k, s);
  }
  params.set("page", String(page));
  return (
    <Link
      href={`/activity?${params.toString()}`}
      className="inline-flex h-8 items-center rounded-md border px-3 font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}
