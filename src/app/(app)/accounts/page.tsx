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
import { createClient } from "@/lib/supabase/server";
import { daysSince, staleTone } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  status?: string;
  stale?: string;
}

const STATUSES = ["all", "active", "prospect", "churned"];

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  // Only the rows this user is allowed to see come back -- the filtering
  // happens in Postgres, under the policies in 0002_rls.sql. Nothing in this
  // file restates the sharing model, which is the point: there is one copy of
  // that rule and it lives in the database.
  let query = supabase
    .from("accounts")
    .select("id, name, status, industry, last_activity_at, owner:users!accounts_owner_id_fkey(full_name)")
    .order("last_activity_at", { ascending: true, nullsFirst: true })
    .limit(200);

  if (params.q) query = query.ilike("name", `%${params.q}%`);
  if (params.status && params.status !== "all") query = query.eq("status", params.status);

  if (params.stale) {
    const days = Number(params.stale);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      // `or` rather than a plain lt: an account that has NEVER had qualifying
      // activity is the most stale of all, and a lt() filter would drop it.
      query = query.or(`last_activity_at.lt.${cutoff},last_activity_at.is.null`);
    }
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load accounts: {error.message}
      </p>
    );
  }

  type Row = {
    id: string;
    name: string;
    status: string;
    industry: string | null;
    last_activity_at: string | null;
    owner: { full_name: string } | { full_name: string }[] | null;
  };

  const accounts = (data ?? []) as Row[];
  const ownerName = (owner: Row["owner"]) =>
    Array.isArray(owner) ? owner[0]?.full_name : owner?.full_name;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} visible to you, coldest first.
          </p>
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="w-64">
          <Input name="q" placeholder="Search by name" defaultValue={params.q ?? ""} />
        </div>
        <select
          name="status"
          defaultValue={params.status ?? "all"}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "Any status" : s}
            </option>
          ))}
        </select>
        <select
          name="stale"
          defaultValue={params.stale ?? ""}
          className="h-9 rounded-md border bg-transparent px-3 text-sm"
        >
          <option value="">Any activity</option>
          <option value="30">No qualifying activity in 30 days</option>
          <option value="60">No qualifying activity in 60 days</option>
          <option value="90">No qualifying activity in 90 days</option>
        </select>
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
              <TableHead>Account</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Nothing matches those filters.
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((account) => {
                const days = daysSince(account.last_activity_at);
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
                      {ownerName(account.owner) ?? "Unassigned"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {account.industry ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.status === "active" ? "secondary" : "outline"}>
                        {account.status}
                      </Badge>
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${staleTone(days)}`}>
                      {days === null ? "never" : days === 0 ? "today" : `${days}d ago`}
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
