import Link from "next/link";
import { Building2, ExternalLink, Lock, Network, Star, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/info-tip";
import { LifecycleFlag } from "@/components/lifecycle-flag";
import { ClaimButton } from "@/app/(app)/available/claim-button";
import { currentUser } from "@/lib/supabase/server";
import { loadPreferences } from "@/lib/prefs-server";
import { resolvePageSize } from "@/lib/preferences";
import {
  fetchProspectCounts,
  fetchProspectIndustries,
  fetchProspects,
  type ProspectRow,
} from "@/lib/prospects";
import { STATUS_LABEL } from "@/lib/account-filters";
import { daysSince, staleTone } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { PageSizePicker, SortPicker } from "./controls";

/**
 * Prospects and Your customers, which are one screen.
 *
 * ===========================================================================
 * WHAT ALEX ASKED FOR
 *
 *   "In salesforce there are two primary tabs. Prospects / Customers. I want
 *    all accounts in the system customer or not to be visible under prospects.
 *    Under customers I would like it to be changed to, Your customers. We want
 *    the available accounts to be found under prospects through search. We want
 *    taken accounts to be found there too. It needs to be easy for someone to
 *    find and identify taken accounts so people do not step on each others
 *    toes."
 *
 * WHY ONE COMPONENT AND TWO ROUTES
 *
 * They are the same list of the same objects, filtered differently. Building
 * them separately is how the search box ends up behaving one way on one tab and
 * another way on the other -- and the search box is the thing Alex uses this
 * screen for.
 *
 * WHAT MAKES A TAKEN ACCOUNT OBVIOUS
 *
 * Three signals, deliberately redundant, because this is the one thing on the
 * screen somebody must not miss:
 *
 *   a coloured left edge, so a scan down the list separates the groups;
 *   a chip naming the holder in words, because roughly one man in twelve
 *     cannot separate the greens from the ambers;
 *   the row being flat rather than a link, so clicking it does nothing instead
 *     of opening a page that refuses.
 *
 * A held row still shows its address and industry. That is the whole reason it
 * is here: knowing WHICH company is taken is what stops the second call.
 * ===========================================================================
 */

export type BrowserTab = "prospects" | "customers";

const SCOPES = [
  { key: "all", label: "Everything", countKey: "total" as const },
  { key: "available", label: "Available", countKey: "available" as const },
  { key: "mine", label: "Mine", countKey: "mine" as const },
  { key: "held", label: "Held by others", countKey: "held" as const },
];

export async function ProspectBrowser({
  tab,
  searchParams,
}: {
  tab: BrowserTab;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const one = (key: string) => {
    const v = searchParams[key];
    return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  };

  const search = one("q");
  const state = one("st").toUpperCase().slice(0, 2);
  const industry = one("industry");
  const status = one("status");
  const sort = ["relevance", "name", "urgency", "recent"].includes(one("sort"))
    ? one("sort")
    : "relevance";
  const page = Math.max(1, Number.parseInt(one("page") || "1", 10) || 1);

  // Your customers is not a scope somebody chooses inside Prospects; it is the
  // other tab. Forcing it here means the sub-tabs cannot contradict the tab.
  const requestedScope = one("scope");
  const scope =
    tab === "customers"
      ? "customers"
      : SCOPES.some((s) => s.key === requestedScope)
        ? requestedScope
        : "all";

  const [me, prefs] = await Promise.all([currentUser(), loadPreferences()]);
  const perPage = resolvePageSize(one("per") || undefined, prefs.rows_per_page);

  const filters = { search, state, industry, status };
  const [result, counts, industries] = await Promise.all([
    fetchProspects({ ...filters, scope, sort, limit: perPage, offset: (page - 1) * perPage }),
    fetchProspectCounts(filters),
    fetchProspectIndustries(),
  ]);

  const total = result.total;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const shown = result.rows.length;
  const firstRow = (page - 1) * perPage;

  const link = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      const s = Array.isArray(v) ? v[0] : v;
      if (s) next.set(k, s);
    }
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    const base = tab === "customers" ? "/customers" : "/prospects";
    return qs ? `${base}?${qs}` : base;
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <header className="space-y-3">
        {/* The two primary tabs, at the top, before anything else on the page.
            Everything under them is a way of narrowing one of the two. */}
        <nav className="flex items-end gap-1 border-b" aria-label="Accounts">
          <PrimaryTab href="/prospects" active={tab === "prospects"} label="Prospects" />
          <PrimaryTab href="/customers" active={tab === "customers"} label="Your customers" />
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              {tab === "customers" ? "Your customers" : "Prospects"}
              <InfoTip
                side="bottom"
                text={
                  tab === "customers"
                    ? "Companies you hold that have converted to customers. Somebody else's customer is not on this list — it is on theirs."
                    : "Every company on file, whoever holds it. You can always see the name, address, industry and who has it. What is inside an account somebody else holds stays with them until it returns to the available pool."
                }
              />
            </h1>
            <p className="text-sm text-muted-foreground">
              {tab === "customers"
                ? "Converted, and in your name."
                : "Every company in the business — available, yours, or somebody else's. Search before you prospect."}
            </p>
          </div>
          <Link
            href="/accounts/new"
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            New company
          </Link>
        </div>
      </header>

      {/* A plain GET form. No debounce, no JavaScript, and the result is a real
          URL somebody can bookmark or paste to a colleague. */}
      <form method="get" className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        {tab === "prospects" && scope !== "all" ? (
          <input type="hidden" name="scope" value={scope} />
        ) : null}
        <input type="hidden" name="per" value={String(perPage)} />
        <div className="relative min-w-60 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Company, city, street, industry, website or phone number…"
            aria-label="Search companies"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-ring"
          />
        </div>
        <input
          type="text"
          name="st"
          defaultValue={state}
          placeholder="ST"
          maxLength={2}
          aria-label="State"
          className="h-9 w-16 rounded-md border bg-background px-2 text-sm uppercase outline-none focus:border-ring"
        />
        <select
          name="industry"
          defaultValue={industry}
          data-set={industry !== ""}
          aria-label="Industry"
          className="h-9 max-w-56 rounded-md border bg-background px-2 text-sm data-[set=true]:border-navy-500 data-[set=true]:bg-navy-50 data-[set=true]:font-medium dark:data-[set=true]:bg-navy-900"
        >
          <option value="">Any industry</option>
          {industries.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <button className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">
          Search
        </button>
        {search || state || industry ? (
          <Link
            href={link({ q: null, st: null, industry: null, page: null })}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-accent"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {tab === "prospects" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((s) => (
              <ScopeTab
                key={s.key}
                href={link({ scope: s.key === "all" ? null : s.key, page: null })}
                active={scope === s.key}
                label={s.label}
                count={counts[s.countKey]}
              />
            ))}
          </div>
          <div className="flex items-center gap-3">
            <SortPicker value={sort} />
            <PageSizePicker value={perPage} />
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-3">
          <SortPicker value={sort} />
          <PageSizePicker value={perPage} />
        </div>
      )}

      {result.error ? (
        <div className="rounded-lg border border-destructive/40 bg-card p-5 text-sm">
          <p className="font-medium text-destructive">This list could not be loaded.</p>
          <p className="mt-1 text-muted-foreground">
            {result.schema
              ? "The database is behind this version of the app. An administrator needs to apply the latest changes from the setup page."
              : "The query failed."}
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{result.error}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5 pl-4 font-medium">Company</th>
                  <th className="px-3 py-2.5 font-medium">Location</th>
                  <th className="px-3 py-2.5 font-medium">Industry</th>
                  <th className="px-3 py-2.5 font-medium">
                    <span className="inline-flex items-center gap-1">
                      Who has it
                      <InfoTip
                        side="bottom"
                        text="Everyone can see this, on every company. It is the whole reason held accounts appear here rather than being hidden."
                      />
                    </span>
                  </th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Last counted</th>
                  <th className="px-3 py-2.5 pr-4 text-right font-medium">Clock</th>
                </tr>
              </thead>
              <tbody>
                {shown === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-16 text-center">
                      <Building2 className="mx-auto size-6 text-muted-foreground/50" aria-hidden />
                      <p className="mt-2 text-sm font-medium">
                        {tab === "customers"
                          ? "You have no customers matching that."
                          : "No company matches that."}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tab === "customers" ? (
                          <>
                            An account becomes a customer when its status is set to Customer.{" "}
                            <Link href="/prospects?scope=mine" className="text-primary hover:underline">
                              See everything you hold
                            </Link>
                            .
                          </>
                        ) : (
                          // This list contains every company in the business, so
                          // an empty result really does mean nobody has heard of
                          // them -- which is worth saying outright, because on
                          // the old screen it usually meant the opposite.
                          <>
                            This searches every company on file, held or not — so nothing here
                            means the company is not in the system yet.{" "}
                            <Link href="/accounts/new" className="text-primary hover:underline">
                              Add it
                            </Link>
                            .
                          </>
                        )}
                      </p>
                    </td>
                  </tr>
                ) : (
                  result.rows.map((row) => <Row key={row.id} row={row} myId={me?.id ?? null} />)
                )}
              </tbody>
            </table>
          </div>

          {total > perPage ? (
            <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
              <p className="tabular-nums text-muted-foreground">
                {firstRow + 1}–{Math.min(firstRow + perPage, total)} of {total.toLocaleString()}
              </p>
              <div className="flex items-center gap-1">
                <PageLink href={link({ page: String(page - 1) })} disabled={page <= 1}>
                  Previous
                </PageLink>
                <span className="px-2 text-xs tabular-nums text-muted-foreground">
                  {page} / {lastPage}
                </span>
                <PageLink href={link({ page: String(page + 1) })} disabled={page >= lastPage}>
                  Next
                </PageLink>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Row({ row, myId }: { row: ProspectRow; myId: string | null }) {
  const mine = myId !== null && (row.ownerId === myId || row.adOwnerId === myId);
  /*
   * The left edge, which is what a scan actually reads.
   *
   * Green is an invitation, amber is somebody else's, and a row of your own is
   * left unmarked -- if everything is highlighted then nothing is, and your own
   * book is the ordinary case on this screen.
   */
  const edge = row.available
    ? "border-l-emerald-500"
    : !row.canOpen
      ? "border-l-amber-400"
      : mine
        ? "border-l-brand-500"
        : "border-l-transparent";

  return (
    <tr className={`border-b border-l-[3px] last:border-b-0 hover:bg-accent/40 ${edge}`}>
      <td className="px-3 py-2.5 pl-4">
        <div className="flex items-center gap-1.5">
          {row.canOpen ? (
            <Link href={`/accounts/${row.id}`} className="font-medium hover:underline">
              {row.name}
            </Link>
          ) : (
            // Not a link. A row that navigates to a page refusing to show you
            // anything is worse than a row that does not navigate.
            <span className="font-medium">{row.name}</span>
          )}
          {row.nationalAccount ? (
            <Star
              className="size-3.5 shrink-0 fill-brand-400 text-brand-500"
              aria-label="National account"
            />
          ) : null}
          {row.childCount !== null && row.childCount > 0 ? (
            <span
              title={`${row.childCount} child accounts`}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-secondary px-1 text-[10px] font-medium text-secondary-foreground"
            >
              <Network className="size-2.5" aria-hidden />
              {row.childCount}
            </span>
          ) : null}
          {row.lockedToCredit ? (
            <span
              title="Flagged as a possible duplicate. Customer Credit decides which record is real."
              className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              duplicate?
            </span>
          ) : null}
          {row.contactCount === 0 ? (
            <span
              title="No contacts on file, so no inbound call can be matched to this company"
              className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              no contacts
            </span>
          ) : null}
        </div>
        {/* Phone and website only when the row is open. Both are on the
            company's own website, but they are still inside somebody's account
            and the rule Alex set does not have an exception for "public". */}
        {row.canOpen && (row.phoneE164 || row.website) ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {row.phoneE164 ? (
              <a href={`tel:${row.phoneE164}`} className="hover:underline">
                {formatPhone(row.phoneE164)}
              </a>
            ) : null}
            {row.website ? (
              <a
                href={/^https?:\/\//i.test(row.website) ? row.website : `https://${row.website}`}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                {row.website.replace(/^https?:\/\//, "")}
                <ExternalLink className="size-2.5" aria-hidden />
              </a>
            ) : null}
          </div>
        ) : null}
      </td>

      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
        {row.billingCity && row.billingState
          ? `${row.billingCity}, ${row.billingState}`
          : (row.billingCity ?? row.billingState ?? "—")}
      </td>

      <td className="px-3 py-2.5 text-muted-foreground">{row.industry ?? "—"}</td>

      <td className="px-3 py-2.5">
        <Holder row={row} mine={mine} />
      </td>

      <td className="px-3 py-2.5">
        {row.canOpen && row.status ? (
          <Badge variant={row.status === "customer" ? "default" : "outline"}>
            {STATUS_LABEL[row.status] ?? row.status}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        {row.canOpen ? <LastCounted at={row.lastActivityAt} /> : <Withheld />}
      </td>

      <td className="whitespace-nowrap px-3 py-2.5 pr-4 text-right">
        {row.available ? (
          <ClaimButton accountId={row.id} />
        ) : row.canOpen && row.lifecycleState ? (
          <LifecycleFlag
            state={row.lifecycleState as Parameters<typeof LifecycleFlag>[0]["state"]}
            daysLeft={row.daysLeft}
          />
        ) : (
          <Withheld />
        )}
      </td>
    </tr>
  );
}

/**
 * Who has it, in words.
 *
 * The chip carries the lock icon AND the word "held" AND the person's name.
 * Three ways of saying the same thing, because this is the cell that decides
 * whether somebody spends a fortnight on a company a colleague is already
 * working.
 */
function Holder({ row, mine }: { row: ProspectRow; mine: boolean }) {
  if (row.available) {
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
        Available
      </span>
    );
  }

  const names = [row.ownerName, row.adOwnerName].filter(Boolean).join(" · ");

  if (mine) {
    return (
      <span className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:border-brand-900 dark:bg-brand-950/60 dark:text-brand-300">
        Yours{row.adOwnerName && row.ownerName ? ` · with ${names}` : ""}
      </span>
    );
  }

  if (!row.canOpen) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <Lock className="size-3 shrink-0" aria-hidden />
        Held by {names || "somebody"}
      </span>
    );
  }

  // Openable but not yours: a report's account, or an account you can reach
  // because of your role rather than because you hold it.
  return <span className="text-xs text-muted-foreground">{names || "—"}</span>;
}

function LastCounted({ at }: { at: string | null }) {
  const d = daysSince(at);
  return (
    <span className={`text-xs ${staleTone(d)}`}>
      {d === null ? "never" : d === 0 ? "today" : `${d}d ago`}
    </span>
  );
}

/**
 * A cell that is deliberately empty.
 *
 * A dash rather than a zero or a blank. Blank reads as missing data and zero
 * reads as a measurement -- "no activity on this account" -- which is a claim
 * about somebody else's work that this screen cannot make.
 */
function Withheld() {
  return (
    <span className="text-xs text-muted-foreground/60" title="Held by somebody else">
      —
    </span>
  );
}

function PrimaryTab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function ScopeTab({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-accent"
      }`}
    >
      {label}
      <span className={active ? "opacity-80" : "text-muted-foreground"}>
        {count.toLocaleString()}
      </span>
    </Link>
  );
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
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
  return (
    <Link
      href={href}
      className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-accent"
    >
      {children}
    </Link>
  );
}
