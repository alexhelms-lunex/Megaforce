import Link from "next/link";
import { AlertOctagon, Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTip } from "@/components/info-tip";
import { LifecycleFlag } from "@/components/lifecycle-flag";
import { poolAccounts, poolFacets, explain, type PoolAccount } from "@/lib/pool";
import { PoolFilterBar } from "./filter-bar";
import { ClaimButton } from "./claim-button";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * The available pool, in full.
 *
 * ---------------------------------------------------------------------------
 * The dock beside the phone is where claiming actually happens — it is open
 * while you are on a call, and it takes ten seconds. This screen is the other
 * half: browsing the pool properly, with filters, when hunting for something
 * specific rather than taking whatever is warm.
 *
 * Both read through poolAccounts() so they cannot disagree about what is
 * claimable.
 *
 * Every read is wrapped. A server component that throws renders as a blank
 * "server-side exception" page with the message REDACTED in production, which
 * is how this screen spent a day telling nobody anything. Catching here means
 * the actual cause is on the screen, and the rest of the page still draws.
 * ---------------------------------------------------------------------------
 */
export default async function AvailablePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const v = params[key];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const page = Math.max(1, Number(one("page")) || 1);
  const sortParam = one("sort");
  const sort = sortParam === "oldest" || sortParam === "name" ? sortParam : "recent";

  let result;
  let facets = { industries: [] as string[], states: [] as string[] };
  try {
    [result, facets] = await Promise.all([
      poolAccounts({
        q: one("q"),
        industry: one("industry"),
        state: one("state"),
        sort,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
      poolFacets(),
    ]);
  } catch (err) {
    result = {
      accounts: [] as PoolAccount[],
      total: 0,
      error: explain(err instanceof Error ? err.message : String(err)),
    };
  }

  const { accounts, total, error } = result;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Inbox className="size-5 text-muted-foreground" aria-hidden />
            Available accounts
            <InfoTip k="availablePool" side="bottom" />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {error
              ? "The pool could not be read."
              : total === 0
                ? "Nothing unclaimed right now."
                : `${total.toLocaleString()} unclaimed — first broker to claim one owns it.`}
          </p>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 py-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <AlertOctagon className="size-4" aria-hidden />
              This screen could not load the pool
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">{error}</p>
            <p className="pt-1 text-sm">
              <Link href="/admin" className="font-medium text-primary hover:underline">
                Open the Admin screen to check the database →
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <PoolFilterBar industries={facets.industries} states={facets.states} />

          {accounts.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                Nothing here matches. Every account either has a broker on it or falls outside
                these filters.
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        Industry
                        <InfoTip k="filterIndustry" side="bottom" />
                      </span>
                    </TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        Contacts
                        <InfoTip k="filterContacts" side="bottom" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        How it came free
                        <InfoTip k="releaseAction" side="bottom" />
                      </span>
                    </TableHead>
                    <TableHead className="text-right">
                      <span className="inline-flex items-center gap-1">
                        Action
                        <InfoTip k="claimAction" side="bottom" />
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.id} className="border-l-4 border-l-sky-400">
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/accounts/${account.id}`}
                            className="font-medium hover:underline"
                          >
                            {account.name}
                          </Link>
                          <LifecycleFlag state="available" />
                        </div>
                        <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                          {account.status} · {account.stage}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {account.industry ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {account.city && account.state
                          ? `${account.city}, ${account.state}`
                          : (account.state ?? account.city ?? "—")}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {account.contactCount === 0 ? (
                          <span className="text-destructive">none on file</span>
                        ) : (
                          <span className="text-muted-foreground">{account.contactCount}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{describeRelease(account.releaseReason)}</Badge>
                        {account.releasedDaysAgo !== null ? (
                          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                            {account.releasedDaysAgo}d ago
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end">
                          <ClaimButton accountId={account.id} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pages > 1 ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {page} of {pages}
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
        </>
      )}
    </div>
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
      href={`/available?${next.toString()}`}
      className="rounded-full border px-4 py-1.5 font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}

/** Plain language. "expired" tells a broker nothing they can act on. */
function describeRelease(reason: string | null): string {
  switch (reason) {
    case "expired":
      return "Went quiet, timed out";
    case "manual":
      return "Given up";
    case "reassigned":
      return "Reassigned by an admin";
    case "converted":
      return "Converted, handed off";
    default:
      return "Never claimed";
  }
}
