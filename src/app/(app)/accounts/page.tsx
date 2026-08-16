import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LifecycleFlag } from "@/components/lifecycle-flag";
import { createClient, currentUser } from "@/lib/supabase/server";
import { daysSince } from "@/lib/format";
import type { LifecycleState } from "@/lib/lifecycle";

export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  status?: string;
  state?: string;
  mine?: string;
}

const STATUSES = ["all", "prospect", "engaged", "customer", "do_not_contact"];
const STATES = ["all", "overdue", "expiring", "warning", "fresh", "available"];

const STATUS_LABEL: Record<string, string> = {
  all: "Any status",
  prospect: "Prospect",
  engaged: "Engaged",
  customer: "Customer",
  do_not_contact: "Do not contact",
};

const STATE_LABEL: Record<string, string> = {
  all: "Any state",
  overdue: "Releasing",
  expiring: "Expiring",
  warning: "Needs attention",
  fresh: "Active",
  available: "Available",
};

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const me = await currentUser();

  /*
   * Reading from the accounts_with_state view rather than the table.
   *
   * The view computes the lifecycle state in SQL, which is what lets this page
   * sort by urgency and filter by state at the database. Doing it in JavaScript
   * would mean fetching the whole book to colour it, and the definition of
   * "amber" would then exist in two places that could disagree.
   *
   * The view is security_invoker, so the same row level security applies here
   * as to a direct query -- a broker still sees only their own accounts, plus
   * the unclaimed pool.
   */
  let query = supabase
    .from("accounts_with_state")
    .select("id, name, status, industry, last_activity_at, owner_id, owner_name, state, days_left, urgency")
    // Most urgent first: the accounts about to be lost, then the ones going
    // quiet. A broker opening this screen should see what needs doing today
    // without sorting anything.
    .order("urgency", { ascending: true })
    .order("days_left", { ascending: true, nullsFirst: false })
    .limit(200);

  if (params.q) query = query.ilike("name", `%${params.q}%`);
  if (params.status && params.status !== "all") query = query.eq("status", params.status);
  if (params.state && params.state !== "all") query = query.eq("state", params.state);
  if (params.mine === "1" && me) query = query.eq("owner_id", me.id);

  const { data, error } = await query;

  if (error) {
    return <p className="text-sm text-destructive">Could not load accounts: {error.message}</p>;
  }

  type Row = {
    id: string;
    name: string;
    status: string;
    industry: string | null;
    last_activity_at: string | null;
    owner_id: string | null;
    owner_name: string | null;
    state: LifecycleState;
    days_left: number | null;
  };

  const accounts = (data ?? []) as Row[];
  const atRisk = accounts.filter((a) => a.state === "expiring" || a.state === "overdue").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} visible, most urgent first.
            {atRisk > 0 ? (
              <span className="font-medium text-destructive"> {atRisk} at risk of release.</span>
            ) : null}
          </p>
        </div>
        <Link
          href="/accounts/new"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          New company
        </Link>
      </div>

      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="w-56">
          <Input name="q" placeholder="Search by company" defaultValue={params.q ?? ""} />
        </div>
        <select
          name="state"
          defaultValue={params.state ?? "all"}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={params.status ?? "all"}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" name="mine" value="1" defaultChecked={params.mine === "1"} />
          Only mine
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Link
          href="/accounts"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Reset
        </Link>
      </form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last worked</TableHead>
              <TableHead className="text-right">Clock</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  Nothing matches those filters.
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((account) => {
                const idle = daysSince(account.last_activity_at);
                return (
                  <TableRow key={account.id}>
                    <TableCell>
                      <Link
                        href={`/accounts/${account.id}`}
                        className="font-medium hover:underline"
                      >
                        {account.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {account.owner_name ?? (
                        <span className="italic">unclaimed</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {account.industry ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{STATUS_LABEL[account.status] ?? account.status}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {idle === null ? "never" : idle === 0 ? "today" : `${idle}d ago`}
                    </TableCell>
                    <TableCell className="text-right">
                      <LifecycleFlag state={account.state} daysLeft={account.days_left} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
