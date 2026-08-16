import Link from "next/link";
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
import { LifecycleFlag } from "@/components/lifecycle-flag";
import { createClient } from "@/lib/supabase/server";
import { daysSince } from "@/lib/format";
import { ClaimButton } from "./claim-button";

export const dynamic = "force-dynamic";

/**
 * The available pool.
 *
 * The screen that makes the whole mechanic legible: accounts nobody owns,
 * waiting to be taken. Most are here because a broker went quiet on them, which
 * is why the last-release reason is shown -- an account released deliberately
 * and one lost to the clock are different propositions.
 */
export default async function AvailablePage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("accounts_with_state")
    .select("id, name, industry, status, last_activity_at, released_at, last_release_reason")
    .is("owner_id", null)
    .order("released_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (error) {
    return <p className="text-sm text-destructive">Could not load the pool: {error.message}</p>;
  }

  const pool = data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Available accounts</h1>
        <p className="text-sm text-muted-foreground">
          Unclaimed. {pool.length} waiting — first broker to claim one owns it.
        </p>
      </div>

      {pool.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Nothing in the pool. Every account currently has a broker on it.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Last worked</TableHead>
                <TableHead>How it came free</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pool.map((account) => {
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
                      <LifecycleFlag state="available" className="ml-2" />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {account.industry ?? "—"}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {idle === null ? "never" : `${idle}d ago`}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{describeRelease(account.last_release_reason)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <ClaimButton accountId={account.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
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
