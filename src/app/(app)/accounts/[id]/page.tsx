import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Building2,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Globe,
  Landmark,
  Network,
  Phone,
  Star,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CustomFields, type FieldDef } from "@/components/custom-fields";
import { ContactForm } from "@/components/contact-form";
import { CompanyMap } from "@/components/company-map";
import { LifecycleFlag, LifecycleExplanation } from "@/components/lifecycle-flag";
import { ClaimButton, ReleaseButton } from "@/app/(app)/available/claim-button";
import { RequestForm } from "@/components/request-form";
import { AccountTabs } from "./account-tabs";
import type { LifecycleState } from "@/lib/lifecycle";
import { createClient, currentUser, isPrivileged } from "@/lib/supabase/server";
import { daysSince, formatDateTime, formatDuration, formatMoney, staleTone } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { STATUS_LABEL } from "@/lib/account-filters";

export const dynamic = "force-dynamic";

const STAGES = ["Lead", "Contact", "Pitch", "Quote", "Closed"];

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const supabase = await createClient();

  // Issued together. RLS filters every one of them; an account the user cannot
  // see returns nothing here and renders as a 404, which is the right answer --
  // "forbidden" would confirm the record exists.
  const [
    accountRes,
    contactsRes,
    activitiesRes,
    oppsRes,
    defsRes,
    childrenRes,
    claimsRes,
    requestsRes,
    colleaguesRes,
  ] =
    await Promise.all([
      supabase.from("accounts_with_state").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("contacts")
        .select("id, first_name, last_name, title, type, email, phone_e164, created_at")
        .eq("account_id", id)
        .order("last_name"),
      supabase
        .from("activities")
        .select(
          "id, type, direction, subject, occurred_at, duration_seconds, result, source, " +
            "qualifies, qualification_reason, stage_outcome, notes, logged_at, user_id",
        )
        .eq("account_id", id)
        .order("occurred_at", { ascending: false })
        .limit(100),
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
      supabase
        .from("accounts_with_state")
        .select("id, name, status, state, days_left, credit_limit, billing_city, billing_state")
        .eq("parent_account_id", id)
        .order("name"),
      supabase
        .from("account_claims")
        .select("id, user_id, claimed_at, released_at, release_reason")
        .eq("account_id", id)
        .order("claimed_at", { ascending: false })
        .limit(25),
      supabase
        .from("account_requests")
        .select(
          "id, kind, reason, days, status, created_at, decided_at, decision_note, " +
            "requester:users!account_requests_requested_by_fkey(full_name)",
        )
        .eq("account_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
      // Transfer targets for the request form. Row level security limits this
      // to the people the caller can see, which is the right set to hand an
      // account to.
      supabase.from("users").select("id, full_name").in("role", ["broker", "manager"]).order("full_name").limit(500),
    ]);

  const account = accountRes.data;
  if (!account) notFound();

  const me = await currentUser();
  const state = (account.state ?? "fresh") as LifecycleState;
  const isMine = Boolean(me && account.owner_id === me.id);
  const privileged = Boolean(me && isPrivileged(me.role));
  const contacts = (contactsRes.data ?? []) as unknown as Contact[];
  // The select list is built by concatenation, which defeats Supabase's column
  // type inference; the shape is asserted here instead.
  const activities = (activitiesRes.data ?? []) as unknown as Activity[];
  const opportunities = oppsRes.data ?? [];
  const defs = (defsRes.data ?? []) as FieldDef[];
  const children = childrenRes.data ?? [];
  const claims = claimsRes.data ?? [];
  const requests = (requestsRes.data ?? []) as unknown as AccountRequest[];
  const colleagues = ((colleaguesRes.data ?? []) as { id: string; full_name: string }[])
    .filter((u) => u.id !== account.owner_id)
    .map((u) => ({ id: u.id, name: u.full_name }));

  // The rollup is a recursive query, so it is fetched only here rather than
  // being a column on the list view that every row would pay for.
  const rollupRes =
    children.length > 0 || account.parent_account_id
      ? await supabase.rpc("account_credit_rollup", { p_account_id: id })
      : { data: null };
  const rollup = rollupRes.data as number | null;

  const days = daysSince(account.last_activity_at);
  const address = {
    street: account.billing_street,
    city: account.billing_city,
    state: account.billing_state,
    postalCode: account.billing_postal_code,
    country: account.billing_country,
    latitude: account.billing_latitude,
    longitude: account.billing_longitude,
  };

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "activity", label: "Activity", count: activities.length },
    { key: "contacts", label: "Contacts", count: contacts.length },
    { key: "hierarchy", label: "Hierarchy", count: children.length },
    { key: "credit", label: "Credit" },
    { key: "pipeline", label: "Pipeline", count: opportunities.length },
    { key: "ownership", label: "Ownership", count: claims.length },
    { key: "requests", label: "Requests", count: requests.length },
    { key: "details", label: "Details" },
  ];
  const tab = tabs.some((t) => t.key === rawTab) ? (rawTab as string) : "overview";

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      {/* ------------------------------------------------------------------
          Header band. Everything needed to know who this is and what to do
          about them, without scrolling or opening a tab.
         ------------------------------------------------------------------ */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="brand-gradient px-5 py-4 text-white">
          <div className="flex items-center gap-2 text-xs text-white/70">
            <Link href="/accounts" className="hover:text-white hover:underline">
              Accounts
            </Link>
            {account.parent_account_name ? (
              <>
                <ChevronRight className="size-3" aria-hidden />
                <Link
                  href={`/accounts/${account.parent_account_id}`}
                  className="hover:text-white hover:underline"
                >
                  {account.parent_account_name}
                </Link>
              </>
            ) : null}
            <ChevronRight className="size-3" aria-hidden />
            <span className="text-white/90">{account.name}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
            {account.national_account ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-400 px-2.5 py-0.5 text-xs font-bold text-brand-950">
                <Star className="size-3 fill-current" aria-hidden />
                National
              </span>
            ) : null}
            {account.national_account_in_review ? (
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium">
                National — in review
              </span>
            ) : null}
            <Badge variant="secondary">{STATUS_LABEL[account.status] ?? account.status}</Badge>
            <LifecycleFlag state={state} daysLeft={account.days_left} />

            <div className="ml-auto flex items-center gap-2">
              <Link
                href={`/accounts/${account.id}/edit`}
                className="inline-flex h-9 items-center rounded-full bg-white/10 px-3 text-sm font-medium transition-colors hover:bg-white/20"
              >
                Edit
              </Link>
              {/* Claim when unowned; release only what is yours. Taking an
                  account somebody else holds is refused by the database, so the
                  button simply is not offered. */}
              {account.owner_id === null ? (
                <ClaimButton accountId={account.id} size="default" />
              ) : isMine || privileged ? (
                <ReleaseButton accountId={account.id} />
              ) : null}
            </div>
          </div>

          {/* Stage rail. The five stages the dock offers as call outcomes, so
              the pipeline position and the thing that moves it are visibly the
              same field. */}
          <div className="mt-3 flex items-center gap-1">
            {STAGES.map((s, i) => {
              const reached = STAGES.indexOf(account.stage) >= i;
              return (
                <span
                  key={s}
                  className={`flex-1 rounded-full py-1 text-center text-[11px] font-medium transition-colors ${
                    reached ? "bg-brand-400 text-brand-950" : "bg-white/10 text-white/55"
                  }`}
                >
                  {s}
                </span>
              );
            })}
          </div>
        </div>

        <FactStrip
          facts={[
            {
              icon: Phone,
              label: "Phone",
              value: account.phone_e164 ? formatPhone(account.phone_e164) : null,
              href: account.phone_e164 ? `tel:${account.phone_e164}` : undefined,
            },
            {
              icon: Globe,
              label: "Website",
              value: account.website?.replace(/^https?:\/\//, "") ?? null,
              href: account.website ? normalizeUrl(account.website) : undefined,
              external: true,
            },
            { icon: Landmark, label: "Industry", value: account.industry },
            {
              icon: Building2,
              label: "Location",
              value: account.billing_city
                ? `${account.billing_city}${account.billing_state ? `, ${account.billing_state}` : ""}`
                : null,
            },
            {
              icon: UserRound,
              label: "Owner",
              value: account.owner_name ?? "Unclaimed",
              sub: account.owner_location,
            },
            {
              icon: CreditCard,
              label: "Credit",
              value: account.credit_limit ? formatMoney(account.credit_limit) : null,
              sub: account.credit_status,
            },
          ]}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <AccountTabs tabs={tabs} active={tab} basePath={`/accounts/${account.id}`} />

          {tab === "overview" ? (
            <Overview
              account={account}
              activities={activities}
              contacts={contacts}
              days={days}
              state={state}
            />
          ) : null}

          {tab === "activity" ? <ActivityTab activities={activities} /> : null}

          {tab === "contacts" ? (
            <div className="space-y-4">
              <ContactForm accountId={account.id} />
              <ContactsTab contacts={contacts} />
            </div>
          ) : null}

          {tab === "hierarchy" ? (
            <HierarchyTab account={account} childAccounts={children} rollup={rollup} />
          ) : null}

          {tab === "credit" ? <CreditTab account={account} rollup={rollup} childCount={children.length} /> : null}

          {tab === "pipeline" ? <PipelineTab opportunities={opportunities} /> : null}

          {tab === "ownership" ? <OwnershipTab account={account} claims={claims} /> : null}

          {tab === "requests" ? (
            <RequestsTab
              accountId={account.id}
              accountStatus={account.status}
              requests={requests}
              colleagues={colleagues}
              canAsk={isMine || privileged}
            />
          ) : null}

          {tab === "details" ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Custom fields</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Rendered from field_defs. Add a row to that table and the field appears here
                  without a release.
                </p>
              </CardHeader>
              <CardContent>
                <CustomFields defs={defs} values={account.custom} />
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* ---- right rail ---- */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">The clock</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <LifecycleFlag state={state} daysLeft={account.days_left} />
              <p>
                <LifecycleExplanation state={state} daysLeft={account.days_left} />
              </p>
              <Separator />
              <dl className="space-y-2 text-sm">
                <Row
                  label="Last counted activity"
                  value={
                    <span className={staleTone(days)}>
                      {days === null ? "never" : days === 0 ? "today" : `${days} days ago`}
                    </span>
                  }
                />
                <Row
                  label="Last contact of any kind"
                  value={relative(account.last_communicated_at)}
                />
                <Row label="Claimed" value={relative(account.claimed_at)} />
              </dl>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="text-base">Location</CardTitle>
            </CardHeader>
            <CardContent>
              <CompanyMap name={account.name} address={address} />
            </CardContent>
          </Card>

          {account.ad_owner_name ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Account Director</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm font-medium">{account.ad_owner_name}</p>
                <p className="text-xs text-muted-foreground">
                  Set this customer up. Shares the commission with the broker who runs it.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

interface Fact {
  icon: React.ElementType;
  label: string;
  value: string | null;
  sub?: string | null;
  href?: string;
  external?: boolean;
}

/** The row of key facts under the header. Missing values show as an em dash. */
function FactStrip({ facts }: { facts: Fact[] }) {
  return (
    <dl className="grid divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-6">
      {facts.map((f) => {
        const Icon = f.icon;
        return (
          <div key={f.label} className="min-w-0 px-4 py-2.5 lg:border-l lg:first:border-l-0">
            <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Icon className="size-3" aria-hidden />
              {f.label}
            </dt>
            <dd className="mt-0.5 truncate text-sm font-medium">
              {f.value === null ? (
                <span className="text-muted-foreground">—</span>
              ) : f.href ? (
                <a
                  href={f.href}
                  target={f.external ? "_blank" : undefined}
                  rel={f.external ? "noreferrer noopener" : undefined}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {f.value}
                  {f.external ? <ExternalLink className="size-3" aria-hidden /> : null}
                </a>
              ) : (
                f.value
              )}
            </dd>
            {f.sub ? <dd className="truncate text-xs text-muted-foreground">{f.sub}</dd> : null}
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Activity = {
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
};

type Contact = {
  id: string;
  first_name: string;
  last_name: string;
  title: string | null;
  type: string | null;
  email: string | null;
  phone_e164: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function Overview({
  account,
  activities,
  contacts,
  days,
  state,
}: {
  account: any;
  activities: Activity[];
  contacts: Contact[];
  days: number | null;
  state: LifecycleState;
}) {
  const qualifying = activities.filter((a) => a.qualifies).length;
  const unlogged = activities.filter((a) => a.type === "call" && !a.logged_at).length;

  return (
    <div className="space-y-4">
      {unlogged > 0 ? (
        <div className="rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm dark:bg-amber-950/30">
          <span className="font-semibold">
            {unlogged} call{unlogged === 1 ? "" : "s"} against this company not written up.
          </span>{" "}
          <span className="text-muted-foreground">
            Until each has a contact, notes and a stage, it is not an approved activity and this
            clock keeps running.
          </span>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <MiniStat label="Activities on file" value={activities.length} />
        <MiniStat
          label="Counted toward the clock"
          value={qualifying}
          tone={qualifying === 0 ? "warn" : "good"}
        />
        <MiniStat
          label="Contacts"
          value={contacts.length}
          tone={contacts.length === 0 ? "warn" : "default"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where this stands</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            {account.name} is a <strong>{STATUS_LABEL[account.status] ?? account.status}</strong> at
            stage <strong>{account.stage}</strong>
            {account.owner_name ? (
              <>
                , held by <strong>{account.owner_name}</strong>
                {account.owner_location ? ` out of ${account.owner_location}` : ""}
              </>
            ) : (
              ", currently unclaimed"
            )}
            .{" "}
            {days === null
              ? "No activity has ever qualified against it."
              : `The last activity that counted was ${days} day${days === 1 ? "" : "s"} ago.`}
          </p>
          <LifecycleExplanation state={state} daysLeft={account.days_left} />
          {contacts.length === 0 ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Nobody is on file here. An inbound call from this company cannot be matched to it,
              and an email to it cannot count as activity — the policy requires the address be on
              the record.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Latest activity</CardTitle>
          <Link
            href={`/accounts/${account.id}?tab=activity`}
            className="text-xs font-medium text-primary hover:underline"
          >
            See all {activities.length}
          </Link>
        </CardHeader>
        <CardContent>
          <Timeline activities={activities.slice(0, 6)} />
        </CardContent>
      </Card>
    </div>
  );
}

function ActivityTab({ activities }: { activities: Activity[] }) {
  const qualifying = activities.filter((a) => a.qualifies).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {qualifying} of the last {activities.length} counted
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Every row carries the reason it did or did not count, so &ldquo;why didn&apos;t my call
          log&rdquo; is answered here rather than in a support ticket.
        </p>
      </CardHeader>
      <CardContent>
        <Timeline activities={activities} />
      </CardContent>
    </Card>
  );
}

function Timeline({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">Nothing logged against this company yet.</p>;
  }
  return (
    <ol className="space-y-0">
      {activities.map((a, i) => (
        <li key={a.id}>
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
                {a.stage_outcome ? (
                  <Badge variant="secondary" className="text-[10px]">
                    → {a.stage_outcome}
                  </Badge>
                ) : null}
                <span className="truncate text-sm font-medium">{a.subject ?? "—"}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(a.occurred_at)}
                {a.duration_seconds !== null ? ` · ${formatDuration(a.duration_seconds)}` : ""}
                {a.result ? ` · ${a.result}` : ""}
                {` · via ${a.source}`}
              </p>
              {a.notes ? <p className="text-sm">{a.notes}</p> : null}
              <p className="text-xs text-muted-foreground">{a.qualification_reason}</p>
            </div>
            <Badge variant={a.qualifies ? "secondary" : "outline"} className="shrink-0">
              {a.type === "call" && !a.logged_at
                ? "not written up"
                : a.qualifies
                  ? "counted"
                  : "not counted"}
            </Badge>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ContactsTab({ contacts }: { contacts: Contact[] }) {
  if (contacts.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <UserRound className="mx-auto size-6 text-muted-foreground/50" aria-hidden />
          <p className="mt-2 text-sm font-medium">Nobody on file</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            A company with no contact has no phone number and no email address on the record, so
            no inbound call can be matched to it and no email to it can ever count as an approved
            activity.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0 pt-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-5 py-2 font-medium">Phone</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="border-b last:border-b-0 hover:bg-accent/40">
                <td className="px-5 py-2.5 font-medium">
                  {c.first_name} {c.last_name}
                </td>
                <td className="px-3 py-2.5">
                  {c.type ? (
                    <Badge variant="outline" className="text-[10px]">
                      {c.type}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">not set</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{c.title ?? "—"}</td>
                <td className="px-3 py-2.5">
                  {c.email ? (
                    <a href={`mailto:${c.email}`} className="text-primary hover:underline">
                      {c.email}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-5 py-2.5">
                  {c.phone_e164 ? (
                    <a href={`tel:${c.phone_e164}`} className="hover:underline">
                      {formatPhone(c.phone_e164)}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function HierarchyTab({
  account,
  childAccounts,
  rollup,
}: {
  account: any;
  childAccounts: any[];
  rollup: number | null;
}) {
  if (!account.parent_account_id && childAccounts.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Network className="mx-auto size-6 text-muted-foreground/50" aria-hidden />
          <p className="mt-2 text-sm font-medium">Standalone company</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            No parent and no service accounts beneath it. Set a parent on the edit screen to roll
            this company&apos;s credit line up into a location account.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Corporate structure</CardTitle>
          <p className="text-xs text-muted-foreground">
            Credit rolls up this tree. Ownership does not — each account is claimed and worked on
            its own.
          </p>
        </CardHeader>
        <CardContent className="space-y-1">
          {account.parent_account_name ? (
            <Link
              href={`/accounts/${account.parent_account_id}`}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent"
            >
              <Building2 className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-medium">{account.parent_account_name}</span>
              <span className="text-xs text-muted-foreground">parent</span>
            </Link>
          ) : null}

          <div
            className={`flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-sm ${
              account.parent_account_name ? "ml-5" : ""
            }`}
          >
            <Building2 className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-semibold">{account.name}</span>
            <span className="text-xs text-muted-foreground">this company</span>
          </div>

          {childAccounts.map((c) => (
            <Link
              key={c.id}
              href={`/accounts/${c.id}`}
              className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent ${
                account.parent_account_name ? "ml-10" : "ml-5"
              }`}
            >
              <Building2 className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {[c.billing_city, c.billing_state].filter(Boolean).join(", ")}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatMoney(c.credit_limit)}
              </span>
              <LifecycleFlag state={c.state as LifecycleState} daysLeft={c.days_left} />
            </Link>
          ))}
        </CardContent>
      </Card>

      {rollup !== null ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Combined exposure</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{formatMoney(rollup)}</p>
            <p className="text-xs text-muted-foreground">
              This company&apos;s own line plus every account beneath it, computed on read so it
              cannot drift from the parts.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CreditTab({
  account,
  rollup,
  childCount,
}: {
  account: any;
  rollup: number | null;
  childCount: number;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MiniStat label="Credit line" value={formatMoney(account.credit_limit)} />
        <MiniStat
          label="Status"
          value={account.credit_status ?? "not set"}
          tone={
            account.credit_status === "approved"
              ? "good"
              : account.credit_status === "on_hold" || account.credit_status === "revoked"
                ? "warn"
                : "default"
          }
        />
        <MiniStat
          label={childCount > 0 ? "Rolled up" : "Total exposure"}
          value={formatMoney(rollup ?? account.credit_limit)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How credit behaves here</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Credit is managed in Salesforce for live customers. This record carries the line and
            its state so the sales floor can see it without a second login, and so the parent
            rolls the children up.
          </p>
          <p>
            When a customer goes inactive — 181 days with no load — credit is removed from the
            location account <strong>and every service account beneath it</strong>, not just the
            one that went quiet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function PipelineTab({ opportunities }: { opportunities: any[] }) {
  if (opportunities.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No open opportunities.
        </CardContent>
      </Card>
    );
  }
  const total = opportunities.reduce((s, o) => s + Number(o.amount ?? 0), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{formatMoney(total)} across {opportunities.length}</CardTitle>
      </CardHeader>
      <CardContent>
        {opportunities.map((o, i) => (
          <div key={o.id}>
            {i > 0 ? <Separator /> : null}
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <p className="text-sm font-medium">{o.name}</p>
                <p className="text-xs text-muted-foreground">
                  {o.stage} · closes {o.close_date ?? "—"}
                </p>
              </div>
              <span className="text-sm font-medium tabular-nums">{formatMoney(o.amount)}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function OwnershipTab({ account, claims }: { account: any; claims: any[] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current holding</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <Row label="Owner" value={account.owner_name ?? "Unclaimed"} />
            <Row label="Branch" value={account.owner_location ?? "—"} />
            <Row label="Account Director" value={account.ad_owner_name ?? "None"} />
            <Row label="Claimed" value={relative(account.claimed_at)} />
            <Row label="Last released" value={relative(account.released_at)} />
            <Row label="Release reason" value={account.last_release_reason ?? "—"} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who has held this</CardTitle>
          <p className="text-xs text-muted-foreground">
            Release is a recorded event, not a column going quiet. This is the trail a territory
            argument turns on.
          </p>
        </CardHeader>
        <CardContent>
          {claims.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No claim history recorded.</p>
          ) : (
            <ol className="space-y-0">
              {claims.map((c, i) => (
                <li key={c.id}>
                  {i > 0 ? <Separator /> : null}
                  <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span className="text-muted-foreground">
                      {formatDateTime(c.claimed_at)}
                      {c.released_at ? ` → ${formatDateTime(c.released_at)}` : " → still held"}
                    </span>
                    {c.release_reason ? (
                      <Badge variant="outline" className="text-[10px]">
                        {c.release_reason}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        current
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
interface AccountRequest {
  id: string;
  kind: string;
  reason: string;
  days: number | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  requester: { full_name: string } | null;
}

/**
 * Asking to keep this account, and every previous ask.
 *
 * The history is as important as the form. An account that has been given
 * amnesty three times is a different conversation from one asking for the
 * first time, and the approver should not have to go looking for that.
 */
function RequestsTab({
  accountId,
  accountStatus,
  requests,
  colleagues,
  canAsk,
}: {
  accountId: string;
  accountStatus: string;
  requests: AccountRequest[];
  colleagues: { id: string; name: string }[];
  canAsk: boolean;
}) {
  const open = requests.filter((r) => r.status === "pending");

  return (
    <div className="space-y-4">
      {canAsk && open.length === 0 ? (
        <RequestForm
          accountId={accountId}
          accountStatus={accountStatus}
          colleagues={colleagues}
        />
      ) : null}

      {open.length > 0 ? (
        <div className="rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm dark:bg-amber-950/30">
          <span className="font-semibold">A request is already open on this account.</span>{" "}
          <span className="text-muted-foreground">
            Only one at a time, so two approvers cannot grant the same thing twice.
          </span>{" "}
          <Link href="/requests" className="font-medium text-primary hover:underline">
            See it
          </Link>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request history</CardTitle>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Nobody has asked for anything on this account.
            </p>
          ) : (
            <ol className="space-y-0">
              {requests.map((r, i) => (
                <li key={r.id}>
                  {i > 0 ? <Separator /> : null}
                  <div className="space-y-1 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={r.status === "approved" ? "secondary" : "outline"}>
                        {r.status}
                      </Badge>
                      <span className="text-sm font-medium capitalize">{r.kind}</span>
                      {r.days ? (
                        <span className="text-xs text-muted-foreground">{r.days} days</span>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {r.requester?.full_name ?? "Someone"} · {formatDateTime(r.created_at)}
                      </span>
                    </div>
                    <p className="text-sm">{r.reason}</p>
                    {r.decision_note ? (
                      <p className="text-xs text-muted-foreground">
                        Decision: {r.decision_note}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function MiniStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn";
}) {
  return (
    <div
      className={`rounded-lg border bg-card p-3 ${
        tone === "warn" ? "border-amber-400/60" : tone === "good" ? "border-brand-400/50" : ""
      }`}
    >
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums capitalize">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}

function relative(iso: string | null): string {
  const d = daysSince(iso);
  if (d === null) return "—";
  if (d === 0) return "today";
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
