import Link from "next/link";
import { InfoTip } from "@/components/info-tip";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccountTabs } from "@/app/(app)/accounts/[id]/account-tabs";
import { createClient, currentUser } from "@/lib/supabase/server";
import { formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Administration.
 *
 * Read-only, deliberately. Everything shown here already has a single source of
 * truth in the database — the qualification rules, the retention thresholds,
 * the field definitions — and the point of this screen is to make those visible
 * rather than to add a second place they can be changed from.
 *
 * The thresholds in particular decide when a broker loses an account. Editing
 * them from a web form, with no review and no record of who changed what, is
 * how a company wakes up to find every prospect released overnight. They are
 * changed by migration, and this screen shows what is currently in force.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const me = await currentUser();
  if (!me) return null;
  // Belt and braces: the nav already hides this, and RLS already refuses the
  // writes. A URL typed by hand should still not render the screen.
  if (me.role !== "admin") redirect("/");

  const { tab: rawTab } = await searchParams;
  const supabase = await createClient();

  const [usersRes, rulesRes, retentionRes, fieldsRes, industriesRes] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name, email, role, location, start_date, prospect_limit, manager_id, rc_extension_id, auth_id")
      .order("role")
      .order("full_name")
      .limit(1000),
    supabase
      .from("qualification_rules")
      .select("id, activity_type, min_duration_seconds, requires_outcome, active, allowed_results, direction, updated_at")
      .order("activity_type"),
    supabase
      .from("account_retention_rules")
      .select("id, applies_to, warning_days, expiring_days, release_days, active")
      .order("applies_to"),
    supabase
      .from("field_defs")
      .select("id, object, key, label, type, required, archived, sort")
      .order("object")
      .order("sort")
      .limit(200),
    supabase.from("industries").select("name, sort").order("sort").limit(200),
  ]);

  const users = (usersRes.data ?? []) as UserRow[];
  const rules = (rulesRes.data ?? []) as RuleRow[];
  const retention = (retentionRes.data ?? []) as RetentionRow[];
  const fields = (fieldsRes.data ?? []) as FieldRow[];
  const industries = (industriesRes.data ?? []) as { name: string; sort: number }[];

  const tabs = [
    { key: "overview", label: "Rules in force" },
    { key: "users", label: "People", count: users.length },
    { key: "fields", label: "Fields", count: fields.length },
    { key: "industries", label: "Industries", count: industries.length },
  ];
  const tab = tabs.some((t) => t.key === rawTab) ? (rawTab as string) : "overview";

  const unlinked = users.filter((u) => !u.auth_id).length;

  return (
    <div className="mx-auto max-w-[1300px] space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="text-sm text-muted-foreground">
          What the system is currently enforcing, and who it is enforcing it on.
        </p>
      </header>

      <AccountTabs tabs={tabs} active={tab} basePath="/admin" />

      {tab === "overview" ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-base">What counts as approved activity<InfoTip k="approvedActivityRules" side="bottom" /></CardTitle>
              <p className="text-xs text-muted-foreground">
                The rules the qualifier runs on every inbound call and email. Changing these
                changes who keeps which account, so they live in migrations rather than in a form.
              </p>
            </CardHeader>
            <CardContent className="px-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-6 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Minimum length</th>
                    <th className="px-3 py-2 font-medium">Outcome required</th>
                    <th className="px-3 py-2 font-medium">Direction</th>
                    <th className="px-6 py-2 font-medium">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <td className="px-6 py-2.5 font-medium capitalize">{r.activity_type}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {r.min_duration_seconds ? formatDuration(r.min_duration_seconds) : "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.requires_outcome ? (
                          <Badge variant="secondary">yes</Badge>
                        ) : (
                          <span className="text-muted-foreground">no</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {r.direction ?? "either"}
                      </td>
                      <td className="px-6 py-2.5">
                        {r.active ? (
                          <Badge variant="secondary">on</Badge>
                        ) : (
                          <Badge variant="outline">off</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-base">The clock<InfoTip k="clock" side="bottom" /></CardTitle>
              <p className="text-xs text-muted-foreground">
                Days from the last approved activity. Amber at the first, red at the second,
                released at the third.
              </p>
            </CardHeader>
            <CardContent className="px-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-6 py-2 font-medium">Applies to</th>
                    <th className="px-3 py-2 text-right font-medium">Needs attention</th>
                    <th className="px-3 py-2 text-right font-medium">Expiring</th>
                    <th className="px-3 py-2 text-right font-medium">Released</th>
                    <th className="px-6 py-2 font-medium">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {retention.map((r) => (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <td className="px-6 py-2.5 font-medium capitalize">{r.applies_to}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{r.warning_days}d</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{r.expiring_days}d</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{r.release_days}d</td>
                      <td className="px-6 py-2.5">
                        {r.active ? (
                          <Badge variant="secondary">on</Badge>
                        ) : (
                          <Badge variant="outline">off</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-base">Known gaps<InfoTip k="knownGaps" side="bottom" /></CardTitle>
              <p className="text-xs text-muted-foreground">
                Written down here rather than left to be discovered.
              </p>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Gap title="The active-customer clock is not running.">
                The policy measures a live customer in <strong>loads</strong> — 90 days without one
                is At Risk, 181 releases the account and strips credit from it and every service
                account beneath it. Loads live in the TMS and never enter this system, so nothing
                here can see them. This needs a feed from the TMS, or the customer clock stays
                manual.
              </Gap>
              <Gap title="Cooldowns are not enforced yet.">
                Thirty days before the same broker may re-add an account they lost, thirty on the
                assign feature for the receiving broker, and a 365-day maximum hold. The data to
                enforce these is recorded in account_claims; the checks are not written.
              </Gap>
              <Gap title="Industry values between two ranges are reconstructed.">
                The screenshots did not capture the picklist between &ldquo;Beverages&rdquo; and
                &ldquo;Equipment&rdquo;, or between &ldquo;Food Ingredients&rdquo; and
                &ldquo;Lumber&rdquo;. Replace them with the exact Salesforce values before importing
                or those rows land in TBD.
              </Gap>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {tab === "users" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">People</CardTitle>
            <p className="text-xs text-muted-foreground">
              {unlinked > 0 ? (
                <span className="text-amber-600">
                  {unlinked} of {users.length} have no login linked yet.
                </span>
              ) : (
                "Every profile has a login linked."
              )}
            </p>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-6 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Branch</th>
                    <th className="px-3 py-2 font-medium">Started</th>
                    <th className="px-3 py-2 text-right font-medium">Limit</th>
                    <th className="px-3 py-2 font-medium">Extension</th>
                    <th className="px-6 py-2 font-medium">Login</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b last:border-b-0 hover:bg-accent/40">
                      <td className="px-6 py-2.5">
                        <Link href={`/accounts?owner=${u.id}`} className="font-medium hover:underline">
                          {u.full_name}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{u.email}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="outline">{u.role}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{u.location ?? "—"}</td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                        {u.start_date ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {u.prospect_limit ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                        {u.rc_extension_id ?? "—"}
                      </td>
                      <td className="px-6 py-2.5">
                        {u.auth_id ? (
                          <Badge variant="secondary">linked</Badge>
                        ) : (
                          <span className="text-xs text-amber-600">not linked</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {tab === "fields" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Custom fields</CardTitle>
            <p className="text-xs text-muted-foreground">
              Add a row to field_defs and the field appears on the create, edit and detail screens
              without a release.
            </p>
          </CardHeader>
          <CardContent className="px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-6 py-2 font-medium">Object</th>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Label</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-6 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.id} className="border-b last:border-b-0">
                    <td className="px-6 py-2.5 capitalize">{f.object}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{f.key}</td>
                    <td className="px-3 py-2.5">{f.label}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{f.type}</td>
                    <td className="px-6 py-2.5">
                      {f.archived ? (
                        <Badge variant="outline">archived</Badge>
                      ) : f.required ? (
                        <Badge variant="secondary">required</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">optional</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      {tab === "industries" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Industry picklist</CardTitle>
            <p className="text-xs text-muted-foreground">
              A controlled list, so an import lands in the right bucket instead of creating
              near-duplicates that silently split every report.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {industries.map((i) => (
                <li key={i.name} className="flex items-center justify-between border-b py-1.5">
                  <Link
                    href={`/accounts?industry=${encodeURIComponent(i.name)}`}
                    className="truncate hover:underline"
                  >
                    {i.name}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Gap({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2.5 dark:bg-amber-950/25">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  location: string | null;
  start_date: string | null;
  prospect_limit: number | null;
  manager_id: string | null;
  rc_extension_id: string | null;
  auth_id: string | null;
}

interface RuleRow {
  id: string;
  activity_type: string;
  min_duration_seconds: number | null;
  requires_outcome: boolean;
  active: boolean;
  allowed_results: string[] | null;
  direction: string | null;
  updated_at: string;
}

interface RetentionRow {
  id: string;
  applies_to: string;
  warning_days: number;
  expiring_days: number;
  release_days: number;
  active: boolean;
}

interface FieldRow {
  id: string;
  object: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  archived: boolean;
  sort: number;
}
