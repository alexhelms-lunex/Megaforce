import Link from "next/link";
import { InfoTip } from "@/components/info-tip";
import { Mail, Phone, Search, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { formatPhone, toE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** The approved sales-contact types from the prospecting policy. */
const CONTACT_TYPES = [
  "Owner",
  "C Suite Level",
  "Director of Supply Chain / Logistics",
  "Procurement",
  "Carrier Relations",
  "4PL Logistics Manager",
  "Logistics Manager",
  "Logistics Coordinator",
  "Logistics Operations",
  "Sales",
  "Buyer / Purchasing",
  "Other",
];

/**
 * The people, rather than the companies.
 *
 * Worth its own screen because of how the policy defines approved activity: an
 * email only counts if it went to a contact ON FILE, and an inbound call only
 * matches if the number is on a contact record. So "who do we actually have at
 * this company, and do we have a way to reach them" is not administrative
 * tidiness — it is the precondition for any activity counting at all.
 *
 * The phone search normalises the term through the same E.164 function that
 * writes the column, so pasting "(704) 555-0142" out of a call log finds the
 * person. Searching the raw string would find nothing, which is the sort of
 * failure people conclude means the contact does not exist.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const get = (k: string) => {
    const v = raw[k];
    return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  };

  const supabase = await createClient();
  const q = get("q");
  const type = get("type");
  const reach = get("reach");
  const page = Math.max(1, Number.parseInt(get("page") || "1", 10) || 1);
  const from = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, title, type, email, phone_e164, account_id, " +
        "accounts(name, status, owner_id, billing_city, billing_state)",
      { count: "exact" },
    )
    .order("last_name")
    .range(from, from + PAGE_SIZE - 1);

  if (q) {
    // PostgREST reads , . ( ) as structure inside an or() filter, so they are
    // stripped rather than escaped — nobody searches a directory for a comma.
    const term = q.replace(/[,()*\\%]/g, " ").trim();
    const asPhone = toE164(q);
    const clauses = [
      `first_name.ilike.%${term}%`,
      `last_name.ilike.%${term}%`,
      `email.ilike.%${term}%`,
      `title.ilike.%${term}%`,
    ];
    if (asPhone) clauses.push(`phone_e164.eq.${asPhone}`);
    if (term) query = query.or(clauses.join(","));
  }
  if (type) query = query.eq("type", type);
  if (reach === "phone") query = query.not("phone_e164", "is", null);
  if (reach === "email") query = query.not("email", "is", null);
  if (reach === "none") query = query.is("phone_e164", null).is("email", null);

  const { data, count, error } = await query;
  if (error) {
    return <p className="text-sm text-destructive">Could not load contacts: {error.message}</p>;
  }

  type Row = {
    id: string;
    first_name: string;
    last_name: string;
    title: string | null;
    type: string | null;
    email: string | null;
    phone_e164: string | null;
    account_id: string;
    accounts:
      | { name: string; status: string; billing_city: string | null; billing_state: string | null }
      | { name: string; status: string; billing_city: string | null; billing_state: string | null }[]
      | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const total = count ?? rows.length;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">Contacts<InfoTip k="contactsScreen" side="bottom" /></h1>
        <p className="text-sm text-muted-foreground">
          An email only counts as activity if it went to somebody on this list.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <div className="relative min-w-60 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            name="q"
            defaultValue={q}
            placeholder="Name, email, title, or paste a phone number…"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-ring"
          />
        </div>
        <select
          name="type"
          defaultValue={type}
          data-set={type !== ""}
          className="h-9 max-w-56 rounded-md border bg-background px-2 text-sm data-[set=true]:border-navy-500 data-[set=true]:bg-navy-50 data-[set=true]:font-medium dark:data-[set=true]:bg-navy-900"
        >
          <option value="">Any contact type</option>
          {CONTACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          name="reach"
          defaultValue={reach}
          data-set={reach !== ""}
          className="h-9 rounded-md border bg-background px-2 text-sm data-[set=true]:border-navy-500 data-[set=true]:bg-navy-50 data-[set=true]:font-medium dark:data-[set=true]:bg-navy-900"
        >
          <option value="">Reachable any way</option>
          <option value="phone">Has a phone number</option>
          <option value="email">Has an email address</option>
          <option value="none">No way to reach them</option>
        </select>
        <button className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">
          Search
        </button>
        <Link
          href="/contacts"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-accent"
        >
          Reset
        </Link>
      </form>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {total.toLocaleString()} {total === 1 ? "contact" : "contacts"}
          </CardTitle>
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
        </CardHeader>
        <CardContent className="px-0">
          {rows.length === 0 ? (
            <div className="py-14 text-center">
              <UserRound className="mx-auto size-6 text-muted-foreground/50" aria-hidden />
              <p className="mt-2 text-sm font-medium">Nobody matches that.</p>
              <p className="text-xs text-muted-foreground">
                Contacts are added from a company&apos;s Contacts tab.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Title</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-5 py-2 font-medium">Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const account = Array.isArray(c.accounts) ? c.accounts[0] : c.accounts;
                    return (
                      <tr key={c.id} className="border-b last:border-b-0 hover:bg-accent/40">
                        <td className="whitespace-nowrap px-5 py-2.5 font-medium">
                          {c.first_name} {c.last_name}
                        </td>
                        <td className="px-3 py-2.5">
                          <Link
                            href={`/accounts/${c.account_id}?tab=contacts`}
                            className="hover:underline"
                          >
                            {account?.name ?? "—"}
                          </Link>
                          {account?.billing_city ? (
                            <span className="block text-xs text-muted-foreground">
                              {account.billing_city}
                              {account.billing_state ? `, ${account.billing_state}` : ""}
                            </span>
                          ) : null}
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
                            <a
                              href={`mailto:${c.email}`}
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <Mail className="size-3" aria-hidden />
                              {c.email}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-2.5">
                          {c.phone_e164 ? (
                            <a
                              href={`tel:${c.phone_e164}`}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              <Phone className="size-3 text-muted-foreground" aria-hidden />
                              {formatPhone(c.phone_e164)}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
      href={`/contacts?${params.toString()}`}
      className="inline-flex h-8 items-center rounded-md border px-3 font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}
