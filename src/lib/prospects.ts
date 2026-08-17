import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Reading the one list that contains every company.
 *
 * ---------------------------------------------------------------------------
 * The shape of a row is the whole point, so it is worth stating here as well as
 * in 0029_prospects.sql: everything above `canOpen` is present for every
 * company in the business, and everything below it is null unless the caller
 * holds the account or is outside the ownership lock.
 *
 * Null, not zero and not "—". A locked row with `contactCount: 0` renders as
 * "no contacts on file", which is a statement about somebody else's account
 * that this row has no business making and which is probably false.
 * ---------------------------------------------------------------------------
 */
export interface ProspectRow {
  id: string;
  name: string;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
  industry: string | null;
  ownerId: string | null;
  ownerName: string | null;
  adOwnerId: string | null;
  adOwnerName: string | null;
  available: boolean;
  canOpen: boolean;
  nationalAccount: boolean;
  lockedToCredit: boolean;

  status: string | null;
  stage: string | null;
  phoneE164: string | null;
  website: string | null;
  creditLimit: string | null;
  creditStatus: string | null;
  lastActivityAt: string | null;
  lastCommunicatedAt: string | null;
  contactCount: number | null;
  childCount: number | null;
  parentAccountName: string | null;
  lifecycleState: string | null;
  daysLeft: number | null;
}

export interface ProspectQuery {
  search: string;
  scope: string;
  state: string;
  industry: string;
  status: string;
  sort: string;
  limit: number;
  offset: number;
}

export interface ProspectCounts {
  total: number;
  available: number;
  mine: number;
  held: number;
  customers: number;
}

export interface ProspectPage {
  rows: ProspectRow[];
  total: number;
  /** Set when the query failed. Null on success, including an empty result. */
  error: string | null;
  /** True when the cause is a database older than this deployment. */
  schema: boolean;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRow(r: Record<string, unknown>): ProspectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    billingStreet: (r.billing_street as string) ?? null,
    billingCity: (r.billing_city as string) ?? null,
    billingState: (r.billing_state as string) ?? null,
    billingPostalCode: (r.billing_postal_code as string) ?? null,
    billingCountry: (r.billing_country as string) ?? null,
    industry: (r.industry as string) ?? null,
    ownerId: (r.owner_id as string) ?? null,
    ownerName: (r.owner_name as string) ?? null,
    adOwnerId: (r.ad_owner_id as string) ?? null,
    adOwnerName: (r.ad_owner_name as string) ?? null,
    available: Boolean(r.available),
    canOpen: Boolean(r.can_open),
    nationalAccount: Boolean(r.national_account),
    lockedToCredit: Boolean(r.locked_to_credit),

    status: (r.status as string) ?? null,
    stage: (r.stage as string) ?? null,
    phoneE164: (r.phone_e164 as string) ?? null,
    website: (r.website as string) ?? null,
    creditLimit: r.credit_limit === null || r.credit_limit === undefined
      ? null
      : String(r.credit_limit),
    creditStatus: (r.credit_status as string) ?? null,
    lastActivityAt: (r.last_activity_at as string) ?? null,
    lastCommunicatedAt: (r.last_communicated_at as string) ?? null,
    contactCount: num(r.contact_count),
    childCount: num(r.child_count),
    parentAccountName: (r.parent_account_name as string) ?? null,
    lifecycleState: (r.lifecycle_state as string) ?? null,
    daysLeft: num(r.days_left),
  };
}

/** A database older than this build, as opposed to a query that went wrong. */
function isSchemaError(message: string): boolean {
  return /does not exist|schema cache|could not find/i.test(message);
}

export async function fetchProspects(q: ProspectQuery): Promise<ProspectPage> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("prospect_list", {
    p_search: q.search,
    p_scope: q.scope,
    p_state: q.state,
    p_industry: q.industry,
    p_status: q.status,
    p_sort: q.sort,
    p_limit: q.limit,
    p_offset: q.offset,
  });

  if (error) {
    return { rows: [], total: 0, error: error.message, schema: isSchemaError(error.message) };
  }

  const raw = (data ?? []) as Record<string, unknown>[];
  return {
    rows: raw.map(toRow),
    // Every row carries the same total; taking it from the first avoids a
    // second count query that could disagree with the page it labels.
    total: raw.length > 0 ? Number(raw[0].total_rows ?? raw.length) : 0,
    error: null,
    schema: false,
  };
}

const NO_COUNTS: ProspectCounts = { total: 0, available: 0, mine: 0, held: 0, customers: 0 };

/**
 * The numbers on the tabs.
 *
 * Never throws and never reports an error. A tab with no number on it is a tab;
 * a screen that failed to load because a count did not is a screen. The list
 * beside it carries the real failure message.
 */
export async function fetchProspectCounts(
  q: Pick<ProspectQuery, "search" | "state" | "industry" | "status">,
): Promise<ProspectCounts> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("prospect_counts", {
      p_search: q.search,
      p_state: q.state,
      p_industry: q.industry,
      p_status: q.status,
    });
    const row = ((data ?? []) as Record<string, unknown>[])[0];
    if (!row) return NO_COUNTS;
    return {
      total: Number(row.total ?? 0),
      available: Number(row.available ?? 0),
      mine: Number(row.mine ?? 0),
      held: Number(row.held ?? 0),
      customers: Number(row.customers ?? 0),
    };
  } catch {
    return NO_COUNTS;
  }
}

/** Industries present anywhere in the business, for the filter menu. */
export async function fetchProspectIndustries(): Promise<string[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("prospect_industries");
    return ((data ?? []) as { industry: string }[]).map((r) => r.industry).filter(Boolean);
  } catch {
    return [];
  }
}
