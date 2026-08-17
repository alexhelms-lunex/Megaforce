import Link from "next/link";
import { InfoTip } from "@/components/info-tip";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient, currentUser } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import { REQUEST_KINDS, REQUEST_KIND_LABEL } from "@/lib/request-kinds";
import { formatMoney } from "@/lib/format";
import { DecideButtons, WithdrawButton } from "./decide-buttons";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  approved: "bg-brand-100 text-brand-800 dark:bg-brand-950 dark:text-brand-200",
  denied: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  withdrawn: "bg-muted text-muted-foreground",
};

/**
 * Account Requests — the amnesty tab.
 *
 * The policy describes amnesty on a prospect and an extension on a customer as
 * separate things. Operationally they are one transaction: an employee asks to
 * hold an account past its window, and somebody above them decides. Building
 * them as one queue means the two approval paths cannot drift apart, and every
 * decision lands in the same audit trail.
 *
 * Row level security does the scoping. "To decide" is simply the open requests
 * raised by somebody other than you that you are allowed to read at all — which
 * for a manager is their whole subtree, and for a broker is nothing.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const me = await currentUser();
  if (!me) return null;

  const params = await searchParams;
  const rawKind = params.kind;
  const kindFilter = (Array.isArray(rawKind) ? rawKind[0] : rawKind) ?? "";
  /*
   * A kind filter, because this queue now has six kinds in it and two of them
   * belong to different people. Credit decides credit limits and nobody else
   * does; a manager decides everything else and cannot decide those. Mixing
   * them in one undifferentiated list means each of them scrolls past the
   * other's work looking for their own.
   */
  const kind = REQUEST_KINDS.some((k) => k.value === kindFilter) ? kindFilter : "";

  let query = supabase
    .from("account_requests")
    .select(
      "id, kind, reason, days, amount, status, created_at, decided_at, decision_note, requested_by, " +
        "accounts(id, name, status), " +
        "requester:users!account_requests_requested_by_fkey(full_name, location), " +
        "decider:users!account_requests_decided_by_fkey(full_name), " +
        "target:users!account_requests_transfer_to_fkey(full_name)",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (kind) query = query.eq("kind", kind);

  const { data, error } = await query;

  if (error) {
    return <p className="text-sm text-destructive">Could not load requests: {error.message}</p>;
  }

  type Row = {
    id: string;
    kind: string;
    reason: string;
    days: number | null;
    amount: number | null;
    status: string;
    created_at: string;
    decided_at: string | null;
    decision_note: string | null;
    requested_by: string;
    accounts: { id: string; name: string; status: string } | null;
    requester: { full_name: string; location: string | null } | null;
    decider: { full_name: string } | null;
    target: { full_name: string } | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const toDecide = rows.filter((r) => r.status === "pending" && r.requested_by !== me.id);
  const mine = rows.filter((r) => r.requested_by === me.id);
  const decided = rows.filter((r) => r.status !== "pending" && r.requested_by !== me.id);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">Account requests<InfoTip k="accountRequest" side="bottom" /></h1>
        <p className="text-sm text-muted-foreground">
          Amnesty on a prospect, an extension on a customer, a transfer, a promotion or a credit
          limit. One queue, one trail.
        </p>

        {/* Chips rather than a dropdown: with six kinds and two different
            approvers, the useful action is "show me only mine", and a chip is
            one click where a select is three. */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <KindChip href="/requests" active={!kind} label="Everything" />
          {REQUEST_KINDS.map((k) => (
            <KindChip
              key={k.value}
              href={`/requests?kind=${k.value}`}
              active={kind === k.value}
              label={REQUEST_KIND_LABEL[k.value] ?? k.value}
            />
          ))}
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Waiting on you
            {toDecide.length > 0 ? (
              <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                {toDecide.length}
              </span>
            ) : null}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Raised by somebody in your reporting line. You cannot decide your own.
          </p>
        </CardHeader>
        <CardContent className="px-0">
          {toDecide.length === 0 ? (
            <div className="py-10 text-center">
              <ShieldCheck className="mx-auto size-6 text-muted-foreground/50" aria-hidden />
              <p className="mt-2 text-sm font-medium">Nothing waiting.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {toDecide.map((r) => (
                <li key={r.id} className="space-y-2 px-5 py-4">
                  <RequestHead row={r} />
                  <p className="text-sm">{r.reason}</p>
                  <DecideButtons requestId={r.id} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Yours</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {mine.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              You have not asked for anything. Raise a request from a company&apos;s page.
            </p>
          ) : (
            <ul className="divide-y">
              {mine.map((r) => (
                <li key={r.id} className="space-y-2 px-5 py-4">
                  <RequestHead row={r} />
                  <p className="text-sm">{r.reason}</p>
                  {r.decision_note ? (
                    <p className="rounded-md bg-muted px-3 py-2 text-sm">
                      <span className="font-medium">{r.decider?.full_name ?? "Reviewer"}:</span>{" "}
                      {r.decision_note}
                    </p>
                  ) : null}
                  {r.status === "pending" ? <WithdrawButton requestId={r.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {decided.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">Already decided<InfoTip k="accountRequest" side="bottom" /></CardTitle>
            <p className="text-xs text-muted-foreground">
              Kept in full. This is the record a territory argument turns on.
            </p>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y">
              {decided.slice(0, 40).map((r) => (
                <li key={r.id} className="space-y-1 px-5 py-3">
                  <RequestHead row={r} />
                  <p className="text-xs text-muted-foreground">
                    {r.reason}
                    {r.decision_note ? ` — ${r.decision_note}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function RequestHead({
  row,
}: {
  row: {
    kind: string;
    days: number | null;
    amount: number | null;
    status: string;
    created_at: string;
    decided_at: string | null;
    accounts: { id: string; name: string; status: string } | null;
    requester: { full_name: string; location: string | null } | null;
    decider: { full_name: string } | null;
    target: { full_name: string } | null;
  };
}) {
  const spec = REQUEST_KINDS.find((k) => k.value === row.kind);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
          STATUS_STYLE[row.status] ?? "bg-muted"
        }`}
      >
        {row.status}
      </span>
      <Badge variant="outline">{REQUEST_KIND_LABEL[row.kind] ?? row.kind}</Badge>
      {row.days ? (
        <span className="text-xs text-muted-foreground">{row.days} days</span>
      ) : null}
      {/* The amount IS the decision on a credit request, so it belongs on the
          row rather than inside it. Approving one without reading the figure
          is the mistake worth designing against. */}
      {row.kind === "credit" && row.amount ? (
        <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs font-semibold tabular-nums">
          {formatMoney(Number(row.amount))}
        </span>
      ) : null}
      {row.accounts ? (
        <Link href={`/accounts/${row.accounts.id}`} className="text-sm font-medium hover:underline">
          {row.accounts.name}
        </Link>
      ) : (
        <span className="text-sm italic text-muted-foreground">account removed</span>
      )}
      {row.target ? (
        <span className="text-xs text-muted-foreground">→ {row.target.full_name}</span>
      ) : null}
      <span className="ml-auto text-xs text-muted-foreground">
        {row.requester?.full_name ?? "Someone"}
        {row.requester?.location ? ` · ${row.requester.location}` : ""} ·{" "}
        {formatDateTime(row.created_at)}
        {row.decided_at ? ` · decided ${formatDateTime(row.decided_at)}` : ""}
      </span>
      <span className="sr-only">{spec?.help}</span>
    </div>
  );
}

function KindChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? "border-transparent bg-primary text-primary-foreground" : "border-border hover:bg-accent"
      }`}
    >
      {label}
    </Link>
  );
}
