import Link from "next/link";
import { redirect } from "next/navigation";
import { Check, ChevronRight, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { createClient, currentUser } from "@/lib/supabase/server";
import { ROLE_BADGE, type Capability } from "@/lib/roles";

export const dynamic = "force-dynamic";

interface Role {
  key: string;
  label: string;
  summary: string;
  sort: number;
}

/**
 * What each role can actually do.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN GRANTS NOTHING. Every row is already enforced by a row level
 * security policy or a trigger; this reads that enforcement back in words.
 *
 * A capability matrix somebody can EDIT is a tempting thing to build and the
 * wrong thing here. The rules are load-bearing — "who can see whose accounts"
 * is the reason row level security exists in this application — and a UI that
 * lets an administrator switch one off at four in the afternoon is a UI that
 * can quietly expose the whole book. Changing one of these is a migration,
 * reviewed, with a test.
 *
 * What the screen is FOR is the question that gets asked constantly and
 * answered inconsistently: why can my manager see my accounts, why can't I
 * edit this one, who is allowed to approve my request. Every one of those is a
 * row here, with the reason beside it.
 * ---------------------------------------------------------------------------
 */
export default async function RolesPage() {
  const me = await currentUser();
  if (!me) return null;
  if (me.role !== "admin") redirect("/");

  const supabase = await createClient();
  const [capsRes, rolesRes, countsRes] = await Promise.all([
    supabase.rpc("role_capabilities"),
    supabase.rpc("role_catalogue"),
    supabase.rpc("admin_user_counts"),
  ]);

  const error = capsRes.error?.message ?? rolesRes.error?.message ?? null;
  const capabilities = (capsRes.data ?? []) as unknown as Capability[];
  const roles = ((rolesRes.data ?? []) as unknown as Role[]).sort((a, b) => a.sort - b.sort);
  const counts = Object.fromEntries(
    ((countsRes.data ?? []) as { bucket: string; n: number }[]).map((r) => [r.bucket, Number(r.n)]),
  );

  const areas = [...new Set(capabilities.map((c) => c.area))];

  return (
    <div className="space-y-5">
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/admin/users" className="hover:text-foreground hover:underline">
          People
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="text-foreground">Roles</span>
      </nav>

      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          What each role can do
          <InfoTip
            side="bottom"
            text="Read from the database, not written down separately. Every row here is enforced by a security policy or a trigger — this screen describes them, it does not control them."
          />
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These cannot be edited here, and that is deliberate: they are the rules that decide who
          can see whose accounts. Changing one is a migration with a test, not an afternoon
          toggle.
        </p>
      </div>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 py-5">
            <p className="text-sm font-semibold text-destructive">
              The role definitions could not be read
            </p>
            <p className="text-sm text-muted-foreground">
              The database is likely behind this version of the app. Re-run setup to apply the
              latest migrations.
            </p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {roles.map((r) => (
              <Card key={r.key} size="sm">
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                        ROLE_BADGE[r.key] ?? ROLE_BADGE.broker
                      }`}
                    >
                      {r.label}
                    </span>
                    <Link
                      href={`/admin/users?role=${r.key}`}
                      className="text-xs tabular-nums text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {counts[r.key] ?? 0} {counts[r.key] === 1 ? "person" : "people"}
                    </Link>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{r.summary}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {areas.map((area) => (
            <Card key={area}>
              <CardHeader>
                <CardTitle className="text-base">{area}</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-5 py-2 text-left font-medium">Can</th>
                        {roles.map((r) => (
                          <th key={r.key} className="w-24 px-2 py-2 text-center font-medium">
                            {r.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {capabilities
                        .filter((c) => c.area === area)
                        .map((c) => (
                          <tr key={c.capability} className="border-b last:border-b-0">
                            <td className="px-5 py-2.5">
                              <p className="font-medium">{c.capability}</p>
                              <p className="text-xs text-muted-foreground">{c.detail}</p>
                            </td>
                            {roles.map((r) => (
                              <td key={r.key} className="px-2 py-2.5 text-center">
                                <Mark
                                  on={Boolean(c[r.key as "broker" | "manager" | "ad" | "credit" | "admin"])}
                                  label={`${r.label} ${
                                    c[r.key as "broker" | "manager" | "ad" | "credit" | "admin"]
                                      ? "can"
                                      : "cannot"
                                  } ${c.capability.toLowerCase()}`}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Yes or no, never colour alone.
 *
 * A green tick and a grey dash are distinguishable by shape as well as by hue,
 * and each carries a label for anyone reading with a screen reader — a matrix
 * of eighty cells is exactly the kind of table that becomes unusable without
 * them.
 */
function Mark({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span
      className="inline-flex size-5 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
      title={label}
    >
      <Check className="size-3" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  ) : (
    <span
      className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground/60"
      title={label}
    >
      <Minus className="size-3" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
