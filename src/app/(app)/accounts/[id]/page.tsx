import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomFields, type FieldDef } from "@/components/custom-fields";
import { createClient } from "@/lib/supabase/server";
import { daysSince, formatDateTime, formatDuration, formatMoney, staleTone } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Five reads, issued together. RLS filters every one of them; an account the
  // user cannot see returns nothing here and renders as a 404, which is the
  // right answer -- "forbidden" would confirm the record exists.
  const [accountRes, contactsRes, activitiesRes, oppsRes, defsRes] = await Promise.all([
    supabase
      .from("accounts")
      .select("*, owner:users!accounts_owner_id_fkey(full_name, email)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("contacts")
      .select("id, first_name, last_name, title, email, phone_e164")
      .eq("account_id", id)
      .order("last_name"),
    supabase
      .from("activities")
      .select(
        "id, type, direction, subject, occurred_at, duration_seconds, result, source, qualifies, qualification_reason",
      )
      .eq("account_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("opportunities")
      .select("id, name, stage, amount, close_date")
      .eq("account_id", id)
      .order("close_date"),
    supabase
      .from("field_defs")
      .select("key, label, type, options, required, sort")
      .eq("object", "account")
      .eq("archived", false)
      .order("sort"),
  ]);

  const account = accountRes.data;
  if (!account) notFound();

  const owner = Array.isArray(account.owner) ? account.owner[0] : account.owner;
  const contacts = contactsRes.data ?? [];
  const activities = activitiesRes.data ?? [];
  const opportunities = oppsRes.data ?? [];
  const defs = (defsRes.data ?? []) as FieldDef[];

  const days = daysSince(account.last_activity_at);
  const qualifyingCount = activities.filter((a) => a.qualifies).length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/accounts" className="text-sm text-muted-foreground hover:underline">
          ← Accounts
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
          <Badge variant={account.status === "active" ? "secondary" : "outline"}>
            {account.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {account.industry ?? "No industry"} · owned by {owner?.full_name ?? "unassigned"} ·{" "}
          <span className={staleTone(days)}>
            {days === null ? "no qualifying activity ever" : `last qualifying activity ${days}d ago`}
          </span>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Tabs defaultValue="activity">
            <TabsList>
              <TabsTrigger value="activity">Activity ({activities.length})</TabsTrigger>
              <TabsTrigger value="contacts">Contacts ({contacts.length})</TabsTrigger>
              <TabsTrigger value="pipeline">Pipeline ({opportunities.length})</TabsTrigger>
            </TabsList>

            {/* ------------------------------------------------------------
                The timeline shows qualification_reason on every row, whether
                it counted or not. This is the answer to "why didn't my call
                log" -- readable in five seconds, without a support ticket.
               ------------------------------------------------------------ */}
            <TabsContent value="activity" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {qualifyingCount} of the last {activities.length} qualified
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-0">
                  {activities.length === 0 ? (
                    <p className="py-6 text-sm text-muted-foreground">
                      Nothing logged against this account yet.
                    </p>
                  ) : (
                    activities.map((a, i) => (
                      <div key={a.id}>
                        {i > 0 ? <Separator /> : null}
                        <div className="flex items-start justify-between gap-4 py-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className="capitalize">
                                {a.type}
                              </Badge>
                              {a.direction ? (
                                <span className="text-xs text-muted-foreground">{a.direction}</span>
                              ) : null}
                              <span className="truncate text-sm font-medium">{a.subject}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {formatDateTime(a.occurred_at)}
                              {a.duration_seconds !== null
                                ? ` · ${formatDuration(a.duration_seconds)}`
                                : ""}
                              {a.result ? ` · ${a.result}` : ""}
                              {` · via ${a.source}`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {a.qualification_reason}
                            </p>
                          </div>
                          <Badge variant={a.qualifies ? "secondary" : "outline"}>
                            {a.qualifies ? "counted" : "not counted"}
                          </Badge>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="contacts" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  {contacts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No contacts yet.</p>
                  ) : (
                    contacts.map((c, i) => (
                      <div key={c.id}>
                        {i > 0 ? <Separator /> : null}
                        <div className="flex items-start justify-between gap-4 py-3">
                          <div>
                            <p className="text-sm font-medium">
                              {c.first_name} {c.last_name}
                            </p>
                            <p className="text-xs text-muted-foreground">{c.title ?? "—"}</p>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <p>{c.email ?? "no email"}</p>
                            <p className="tabular-nums">
                              {c.phone_e164 ? formatPhone(c.phone_e164) : "no phone"}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="pipeline" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  {opportunities.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No open opportunities.</p>
                  ) : (
                    opportunities.map((o, i) => (
                      <div key={o.id}>
                        {i > 0 ? <Separator /> : null}
                        <div className="flex items-center justify-between gap-4 py-3">
                          <div>
                            <p className="text-sm font-medium">{o.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {o.stage} · closes {o.close_date ?? "—"}
                            </p>
                          </div>
                          <span className="text-sm font-medium tabular-nums">
                            {formatMoney(o.amount)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Rendered entirely from field_defs. Add a row to that table and
                  the field shows up here without touching this file. */}
              <CustomFields defs={defs} values={account.custom} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
