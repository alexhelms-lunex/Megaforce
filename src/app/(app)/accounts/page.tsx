import Link from "next/link";
import { Building2, ExternalLink, Network, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LifecycleFlag, lifecycleRowAccent } from "@/components/lifecycle-flag";
import { InfoTip } from "@/components/info-tip";
import { COLUMN_HELP } from "@/lib/definitions";
import { FilterBar, type FilterOptions } from "./filter-bar";
import { createClient, currentUser } from "@/lib/supabase/server";
import {
  COLUMNS,
  PAGE_SIZE,
  PRESETS,
  STATUS_LABEL,
  defaultColumns,
  parseFilters,
  toQueryString,
} from "@/lib/account-filters";
import { LIST_COLUMNS, applyAccountFilters, pageRange, type AccountRow } from "@/lib/account-query";
import { daysSince, formatMoney, staleTone } from "@/lib/format";
import { formatPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const filters = parseFilters(raw);
  const supabase = await createClient();
  const me = await currentUser();

  const colsParam = typeof raw.cols === "string" ? raw.cols : "";
  const columns = colsParam
    ? colsParam.split(",").filter((c) => COLUMNS.some((d) => d.key === c))
    : defaultColumns();
  const visible = COLUMNS.filter((c) => columns.includes(c.key));

  const [from, to] = pageRange(filters.page);

  /*
   * Reading from accounts_with_state rather than the table.
   *
   * The view computes the lifecycle state in SQL, which is what lets this
   * screen filter and sort by it at the database and page correctly. Doing it
   * in JavaScript would mean fetching the whole book to colour it, and the
   * definition of "amber" would then live in two places that can disagree.
   *
   * security_invoker on the view means row level security applies exactly as it
   * would to a direct query -- a broker sees their own book plus the pool.
   */
  const listQuery = applyAccountFilters(
    supabase.from("accounts_with_state").select(LIST_COLUMNS, { count: "exact" }),
    filters,
    me?.id ?? null,
  ).range(from, to);

  const [listRes, optionsRes, ownersRes] = await Promise.all([
    listQuery,
    // One round trip for every dropdown's contents, read from the caller's own
    // visible accounts -- so the State list contains the states that exist in
    // this book and nothing else.
    supabase.rpc("account_filter_options"),
    supabase.from("users").select("id, full_name").order("full_name").limit(500),
  ]);

  if (listRes.error) {
    return (
      <p className="text-sm text-destructive">Could not load accounts: {listRes.error.message}</p>
    );
  }

  const rows = (listRes.data ?? []) as unknown as AccountRow[];
  const total = listRes.count ?? rows.length;
  const options = buildOptions(
    (optionsRes.data ?? []) as { kind: string; value: string; uses: number }[],
    (ownersRes.data ?? []) as { id: string; full_name: string }[],
  );

  const preset = PRESETS.find((p) => p.key === filters.preset);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {preset ? preset.label : "Accounts"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {preset ? preset.description : "Every company you can see, most urgent first."}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/available"
            className="inline-flex h-9 items-center rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            Available pool
          </Link>
          <Link
            href="/accounts/new"
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            New company
          </Link>
        </div>
      </header>

      <FilterBar filters={filters} options={options} columns={columns} total={total} />

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                {visible.map((c) => (
                  <th
                    key={c.key}
                    className={`whitespace-nowrap px-3 py-2.5 font-medium first:pl-4 last:pr-4 ${
                      c.numeric || c.key === "clock" ? "text-right" : ""
                    }`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      <InfoTip k={COLUMN_HELP[c.key]} side="bottom" />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={visible.length} className="px-4 py-16 text-center">
                    <Building2 className="mx-auto size-6 text-muted-foreground/50" aria-hidden />
                    <p className="mt-2 text-sm font-medium">Nothing matches those filters.</p>
                    <p className="text-xs text-muted-foreground">
                      Try clearing a filter, or{" "}
                      <Link href="/available" className="text-primary hover:underline">
                        claim something from the pool
                      </Link>
                      .
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-l-[3px] last:border-b-0 hover:bg-accent/40 ${lifecycleRowAccent(row.state)}`}
                  >
                    {visible.map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2.5 first:pl-4 last:pr-4 ${
                          c.numeric || c.key === "clock" ? "text-right" : ""
                        }`}
                      >
                        <Cell column={c.key} row={row} />
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
            <p className="text-muted-foreground tabular-nums">
              {from + 1}–{Math.min(from + PAGE_SIZE, total)} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-1">
              <PageLink filters={filters} cols={colsParam} page={filters.page - 1} disabled={filters.page <= 1}>
                Previous
              </PageLink>
              <span className="px-2 text-xs text-muted-foreground tabular-nums">
                {filters.page} / {lastPage}
              </span>
              <PageLink
                filters={filters}
                cols={colsParam}
                page={filters.page + 1}
                disabled={filters.page >= lastPage}
              >
                Next
              </PageLink>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PageLink({
  filters,
  cols,
  page,
  disabled,
  children,
}: {
  filters: ReturnType<typeof parseFilters>;
  cols: string;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="inline-flex h-8 cursor-not-allowed items-center rounded-md border px-3 text-xs text-muted-foreground/50">
        {children}
      </span>
    );
  }
  const params = new URLSearchParams(toQueryString({ ...filters, page }));
  if (cols) params.set("cols", cols);
  return (
    <Link
      href={`/accounts?${params.toString()}`}
      className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}

function Cell({ column, row }: { column: string; row: AccountRow }) {
  switch (column) {
    case "name":
      return (
        <div className="flex items-center gap-1.5">
          <Link href={`/accounts/${row.id}`} className="font-medium hover:underline">
            {row.name}
          </Link>
          {row.national_account ? (
            <Star className="size-3.5 shrink-0 fill-brand-400 text-brand-500" aria-label="National account" />
          ) : null}
          {row.child_count > 0 ? (
            <span
              title={`${row.child_count} child accounts`}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-secondary px-1 text-[10px] font-medium text-secondary-foreground"
            >
              <Network className="size-2.5" aria-hidden />
              {row.child_count}
            </span>
          ) : null}
          {row.contact_count === 0 ? (
            <span
              title="No contacts on file, so no inbound call can be matched to this company"
              className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              no contacts
            </span>
          ) : null}
        </div>
      );

    case "owner":
      return row.owner_name ? (
        <span className="text-muted-foreground">{row.owner_name}</span>
      ) : (
        <Link href="/available" className="italic text-primary hover:underline">
          unclaimed
        </Link>
      );

    case "location":
      return (
        <span className="whitespace-nowrap text-muted-foreground">
          {row.billing_city && row.billing_state
            ? `${row.billing_city}, ${row.billing_state}`
            : (row.billing_city ?? row.billing_state ?? "—")}
        </span>
      );

    case "industry":
      return <span className="text-muted-foreground">{row.industry ?? "—"}</span>;

    case "status":
      return (
        <Badge variant={row.status === "customer" ? "default" : "outline"}>
          {STATUS_LABEL[row.status] ?? row.status}
        </Badge>
      );

    case "stage":
      return <span className="text-muted-foreground">{row.stage}</span>;

    case "phone":
      return row.phone_e164 ? (
        <a href={`tel:${row.phone_e164}`} className="whitespace-nowrap hover:underline">
          {formatPhone(row.phone_e164)}
        </a>
      ) : (
        <span className="text-muted-foreground">—</span>
      );

    case "website":
      return row.website ? (
        <a
          href={normalizeUrl(row.website)}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          {row.website.replace(/^https?:\/\//, "")}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : (
        <span className="text-muted-foreground">—</span>
      );

    case "parent":
      return <span className="text-muted-foreground">{row.parent_account_name ?? "—"}</span>;

    case "credit":
      return (
        <span className="whitespace-nowrap tabular-nums">
          {formatMoney(row.credit_limit)}
          {row.credit_status && row.credit_status !== "approved" ? (
            <span className="ml-1 text-xs text-muted-foreground">({row.credit_status})</span>
          ) : null}
        </span>
      );

    // "Last contact" is any communication at all; "Last counted" is the one the
    // clock listens to. Showing both is what separates "nothing has happened
    // here" from "things happened but none of them qualified" -- the single
    // most common misunderstanding this system produces.
    case "contacted": {
      const d = daysSince(row.last_communicated_at);
      return (
        <span className="whitespace-nowrap text-muted-foreground">
          {d === null ? "never" : d === 0 ? "today" : `${d}d ago`}
        </span>
      );
    }

    case "activity": {
      const d = daysSince(row.last_activity_at);
      return (
        <span className={`whitespace-nowrap ${staleTone(d)}`}>
          {d === null ? "never" : d === 0 ? "today" : `${d}d ago`}
        </span>
      );
    }

    case "clock":
      return <LifecycleFlag state={row.state} daysLeft={row.days_left} showMeter />;

    default:
      return null;
  }
}

function buildOptions(
  raw: { kind: string; value: string; uses: number }[],
  owners: { id: string; full_name: string }[],
): FilterOptions {
  const of = (kind: string) => raw.filter((r) => r.kind === kind && r.value);
  return {
    industries: of("industry").map((r) => r.value),
    states: of("state").map((r) => ({ value: r.value, uses: Number(r.uses) })),
    // Cities are capped: a national book has thousands, and a dropdown with
    // thousands of entries is a dropdown nobody scrolls. The search box covers
    // the long tail.
    cities: of("city")
      .slice(0, 60)
      .map((r) => ({ value: r.value, uses: Number(r.uses) })),
    ownerLocations: of("owner_location").map((r) => r.value),
    owners: owners.map((o) => ({ id: o.id, name: o.full_name })),
  };
}

function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
