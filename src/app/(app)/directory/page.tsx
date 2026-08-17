import Link from "next/link";
import { Factory, Lock, MapPin, Search, UserRound } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/info-tip";
import { createClient } from "@/lib/supabase/server";
import type { DirectoryEntry } from "@/components/locked-account";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Every company in the business, findable by anybody.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE SCREEN FROM ACCOUNTS
 *
 * The Accounts screen is a working list: presets, columns, the clock, sorting
 * by days left. Every one of those needs the inside of an account, so it can
 * only ever show the ones you may open. Bolting a second, thinner kind of row
 * into it would make every column on it conditional and every filter a lie.
 *
 * This screen answers one question instead, and it is a question the Accounts
 * screen cannot answer at all:
 *
 *     Is this company already somebody's?
 *
 * Before this existed, a colleague's account was not merely closed -- it was
 * invisible. Two brokers could work the same buyer for a month without either
 * discovering the other, and the second one to try claiming it was told the
 * account did not exist.
 *
 * What it shows is deliberately thin: name, address, who holds it. Everything
 * that represents somebody's WORK stays behind the lock. The reasoning, and the
 * exact column list, is in 0024_account_directory.sql.
 * ---------------------------------------------------------------------------
 */
export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const one = (key: string) => {
    const v = raw[key];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const query = one("q");
  const state = one("state").toUpperCase().slice(0, 2);
  const scope = ["all", "locked", "available"].includes(one("scope")) ? one("scope") : "all";
  const page = Math.max(1, Number(one("page")) || 1);

  const supabase = await createClient();

  const [listRes, countsRes] = await Promise.all([
    supabase.rpc("account_directory", {
      p_search: query,
      p_state: state,
      p_scope: scope,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("account_directory_counts"),
  ]);

  const rows = (listRes.data ?? []) as (DirectoryEntry & { total_rows: number })[];
  const counts = ((countsRes.data ?? []) as Record<string, number>[])[0] ?? {};
  const total = Number(rows[0]?.total_rows ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // The migration may not have run yet. Saying so beats an empty screen that
  // looks like a company with no accounts in it.
  const failure = listRes.error?.message ?? null;

  const link = (changes: Record<string, string>) => {
    const params = new URLSearchParams();
    const next = { q: query, state, scope, page: String(page), ...changes };
    for (const [k, v] of Object.entries(next)) {
      if (v && !(k === "page" && v === "1") && !(k === "scope" && v === "all")) params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/directory?${qs}` : "/directory";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          Company directory
          <InfoTip
            text={
              "Every company on file, whoever holds it. You can see the name, the address and " +
              "who holds it. Everything inside an account someone else holds — their contacts, " +
              "calls, notes and pipeline — stays with them until it returns to the available pool."
            }
          />
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every company on file, whoever holds it — name, address, industry and who has it.
          Search before you prospect; it takes a second and it stops two of us calling the same
          buyer in the same week.
        </p>
      </div>

      {/* A plain GET form. No JavaScript, no debounce, and the result is a real
          URL somebody can bookmark or paste to a colleague. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-64 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Company, city, state or industry…"
            className="h-10 w-full rounded-full border border-border bg-background pl-9 pr-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <input
          type="text"
          name="state"
          defaultValue={state}
          placeholder="ST"
          maxLength={2}
          className="h-10 w-20 rounded-full border border-border bg-background px-4 text-sm uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <input type="hidden" name="scope" value={scope} />
        <button
          type="submit"
          className="h-10 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-1.5">
        <Tab href={link({ scope: "all", page: "1" })} active={scope === "all"} label="Everything" count={counts.total} />
        <Tab
          href={link({ scope: "available", page: "1" })}
          active={scope === "available"}
          label="Unclaimed"
          count={counts.available}
        />
        <Tab
          href={link({ scope: "locked", page: "1" })}
          active={scope === "locked"}
          label="Held by others"
          count={counts.locked}
        />
      </div>

      {failure ? (
        <Card size="sm">
          <CardContent className="text-sm">
            <p className="font-medium">The directory is not available yet.</p>
            <p className="mt-1 text-muted-foreground">
              An administrator needs to apply the latest database changes from the setup page.
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{failure}</p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card size="sm">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {query || state
              ? "Nothing matches that. Try a shorter search — the company may be filed under a parent name."
              : "No companies on file."}
          </CardContent>
        </Card>
      ) : (
        <Card size="sm">
          <CardContent className="p-0">
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/accounts/${row.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-accent/40"
                  >
                    <span className="min-w-48 flex-1 font-medium">{row.name}</span>

                    <span className="flex min-w-36 items-center gap-1.5 text-sm text-muted-foreground">
                      <MapPin className="size-3.5 shrink-0" aria-hidden />
                      {[row.billing_city, row.billing_state].filter(Boolean).join(", ") || "—"}
                    </span>

                    <span className="flex min-w-36 items-center gap-1.5 truncate text-sm text-muted-foreground">
                      <Factory className="size-3.5 shrink-0" aria-hidden />
                      {row.industry ?? "—"}
                    </span>

                    <span className="flex min-w-44 items-center gap-1.5 text-sm text-muted-foreground">
                      <UserRound className="size-3.5 shrink-0" aria-hidden />
                      {row.owner_name ?? "Nobody"}
                      {row.ad_owner_name ? ` · ${row.ad_owner_name}` : ""}
                    </span>

                    <Status row={row} />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {pages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {total.toLocaleString()} companies · page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={link({ page: String(page - 1) })} className="rounded-full border border-border px-3 py-1.5 hover:bg-accent">
                Previous
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={link({ page: String(page + 1) })} className="rounded-full border border-border px-3 py-1.5 hover:bg-accent">
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Three states, and only one of them is a refusal.
 *
 * "Unclaimed" is an invitation, "Yours to open" is a fact, and "Held" is the
 * ownership rule working rather than an error -- so it is amber and calm, not
 * red. A red badge here would generate a support message every time somebody
 * searched.
 */
function Status({ row }: { row: DirectoryEntry }) {
  if (row.available) {
    return (
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
        Unclaimed
      </span>
    );
  }
  if (row.can_open) {
    return (
      <span className="rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        Yours to open
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <Lock className="size-3" aria-hidden />
      Held
    </span>
  );
}

function Tab({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border hover:bg-accent"
      }`}
    >
      {label}
      {count !== undefined ? (
        <span className={active ? "opacity-80" : "text-muted-foreground"}>
          {Number(count).toLocaleString()}
        </span>
      ) : null}
    </Link>
  );
}
