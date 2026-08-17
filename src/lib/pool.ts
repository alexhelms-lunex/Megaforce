/**
 * The available pool, defined once.
 *
 * ---------------------------------------------------------------------------
 * The dock and the full pool screen used to run their own queries. They drifted
 * within a day: the dock hid accounts flagged as duplicates and the page did
 * not, so the two surfaces disagreed about what was claimable and a broker
 * could open a company from the page that the dock had already decided was
 * Credit's problem.
 *
 * One function, two presentations. The dock passes a small limit and no
 * filters; the page passes filters and paging. Neither owns the definition of
 * "claimable".
 *
 * ERRORS ARE RETURNED, NOT THROWN OR SWALLOWED. The commonest failure in this
 * application has been a database a migration or two behind the deployment, and
 * both previous behaviours were wrong for it: throwing produced a blank
 * server-error page with the message redacted in production, and swallowing
 * produced an empty pool that looked exactly like a pool with nothing in it.
 * Returning the message lets each caller say what is actually wrong.
 * ---------------------------------------------------------------------------
 */
import { createClient } from "@/lib/supabase/server";
import { daysSince } from "@/lib/format";

export interface PoolAccount {
  id: string;
  name: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  stage: string;
  status: string;
  contactCount: number;
  /** How long it has sat unclaimed. Null when it has never been held. */
  releasedDaysAgo: number | null;
  /** Why it came free. Null when nobody has ever held it. */
  releaseReason: string | null;
}

export interface PoolFilters {
  q?: string;
  industry?: string;
  state?: string;
  /** 'recent' newest release first, 'oldest' longest-sitting first, 'name' A–Z. */
  sort?: "recent" | "oldest" | "name";
  limit?: number;
  offset?: number;
}

export interface PoolResult {
  accounts: PoolAccount[];
  total: number;
  /** Non-null when the read failed. Already in plain language. */
  error: string | null;
}

const COLUMNS =
  "id, name, industry, status, billing_city, billing_state, stage, contact_count, released_at, last_release_reason";

/**
 * What is currently claimable.
 *
 * Default order is recently released first rather than alphabetical. An account
 * that came back into the pool last week is warm -- somebody was working it
 * until days ago -- while one that has sat there for a year has usually sat
 * there for a reason. The order is the recommendation.
 *
 * Read through the authenticated client, so the pool a person sees is the pool
 * row level security says they may see.
 */
export async function poolAccounts(filters: PoolFilters = {}): Promise<PoolResult> {
  const { q = "", industry = "", state = "", sort = "recent", limit = 40, offset = 0 } = filters;

  const supabase = await createClient();

  let request = supabase
    .from("accounts_with_state")
    .select(COLUMNS, { count: "exact" })
    .is("owner_id", null)
    // A flagged duplicate is Credit's problem, not something to hand a broker.
    .eq("locked_to_credit", false);

  if (sort === "name") request = request.order("name", { ascending: true });
  else if (sort === "oldest") request = request.order("released_at", { ascending: true, nullsFirst: true });
  else request = request.order("released_at", { ascending: false, nullsFirst: false });

  if (industry) request = request.eq("industry", industry);
  if (state) request = request.ilike("billing_state", state);

  // PostgREST's or() takes a comma-separated list, so a comma or a bracket in
  // the search term would be read as syntax rather than as text.
  const term = q.replace(/[,()*\\%]/g, " ").trim();
  if (term) {
    request = request.or(
      [
        `name.ilike.%${term}%`,
        `industry.ilike.%${term}%`,
        `billing_city.ilike.%${term}%`,
        `billing_state.ilike.%${term}%`,
      ].join(","),
    );
  }

  const { data, count, error } = await request.range(offset, offset + limit - 1);

  if (error) {
    return { accounts: [], total: 0, error: explain(error.message) };
  }

  type Row = {
    id: string;
    name: string;
    industry: string | null;
    status: string;
    billing_city: string | null;
    billing_state: string | null;
    stage: string | null;
    contact_count: number | null;
    released_at: string | null;
    last_release_reason: string | null;
  };

  return {
    error: null,
    total: count ?? 0,
    accounts: ((data ?? []) as unknown as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      industry: r.industry,
      status: r.status,
      city: r.billing_city,
      state: r.billing_state,
      stage: r.stage ?? "Lead",
      contactCount: Number(r.contact_count ?? 0),
      releasedDaysAgo: daysSince(r.released_at),
      releaseReason: r.last_release_reason,
    })),
  };
}

/**
 * Postgres speaks to developers. This screen speaks to brokers.
 *
 * A missing column means one specific thing here and it is worth naming: the
 * deployment is newer than the database. That has been the cause of every
 * mysterious blank screen in this application so far, and "run setup" is an
 * instruction somebody can actually follow.
 */
export function explain(message: string): string {
  if (/does not exist|schema cache|could not find/i.test(message)) {
    return (
      "The database is behind this version of the app — it is missing a column or view this " +
      "screen needs. An administrator should re-run setup from the Admin screen to apply the " +
      `latest migrations. (${message})`
    );
  }
  if (/permission denied|row-level security/i.test(message)) {
    return "You do not have permission to read the pool.";
  }
  return message;
}

/** The distinct industries and states present in the pool, for the filter menus. */
export async function poolFacets(): Promise<{ industries: string[]; states: string[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("accounts_with_state")
    .select("industry, billing_state")
    .is("owner_id", null)
    .limit(2000);

  if (error || !data) return { industries: [], states: [] };

  const industries = new Set<string>();
  const states = new Set<string>();
  for (const row of data as unknown as { industry: string | null; billing_state: string | null }[]) {
    if (row.industry) industries.add(row.industry);
    if (row.billing_state) states.add(row.billing_state.toUpperCase());
  }
  return {
    industries: [...industries].sort(),
    states: [...states].sort(),
  };
}
