"use server";

import { createClient } from "@/lib/supabase/server";
import { daysSince } from "@/lib/format";

export interface PoolAccount {
  id: string;
  name: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  stage: string;
  contactCount: number;
  /** How long it has sat unclaimed. Null when it has never been held. */
  releasedDaysAgo: number | null;
}

/**
 * What is currently claimable.
 *
 * Ordered by recently released first rather than alphabetically. An account
 * that came back into the pool last week is warm -- somebody was working it
 * until days ago -- while one that has sat there for a year has usually sat
 * there for a reason. The order is the recommendation.
 *
 * Read through the authenticated client, so the pool a person sees is the pool
 * row level security says they may see.
 */
export async function poolAccounts(
  query = "",
  limit = 40,
): Promise<{ accounts: PoolAccount[]; total: number }> {
  const supabase = await createClient();

  let request = supabase
    .from("accounts_with_state")
    .select(
      "id, name, industry, billing_city, billing_state, stage, contact_count, released_at",
      { count: "exact" },
    )
    .is("owner_id", null)
    // A flagged duplicate is Credit's problem, not something to hand a broker.
    .eq("locked_to_credit", false)
    .order("released_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  const term = query.replace(/[,()*\\%]/g, " ").trim();
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

  const { data, count, error } = await request;
  if (error) return { accounts: [], total: 0 };

  type Row = {
    id: string;
    name: string;
    industry: string | null;
    billing_city: string | null;
    billing_state: string | null;
    stage: string;
    contact_count: number;
    released_at: string | null;
  };

  return {
    total: count ?? 0,
    accounts: ((data ?? []) as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      industry: r.industry,
      city: r.billing_city,
      state: r.billing_state,
      stage: r.stage,
      contactCount: Number(r.contact_count ?? 0),
      releasedDaysAgo: daysSince(r.released_at),
    })),
  };
}
