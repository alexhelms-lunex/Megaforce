import "server-only";
import type { AccountFilters } from "./account-filters";
import { PAGE_SIZE } from "./account-filters";
import type { LifecycleState } from "./lifecycle";

/**
 * Turning a parsed filter set into a query against accounts_with_state.
 *
 * Every filter is applied at the database. That is not a micro-optimisation --
 * it is what makes paging correct. Filtering in JavaScript after fetching a
 * page means page two contains different rows than the count promised, and the
 * "1–50 of 812" line becomes a lie.
 *
 * The view is security_invoker, so row level security applies to every one of
 * these queries. Nothing here scopes by user except the explicit `mine` and
 * `owner` filters; visibility is Postgres's job.
 */

export interface AccountRow {
  id: string;
  name: string;
  status: string;
  stage: string;
  industry: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_location: string | null;
  billing_city: string | null;
  billing_state: string | null;
  phone_e164: string | null;
  website: string | null;
  parent_account_name: string | null;
  child_count: number;
  contact_count: number;
  credit_limit: string | null;
  credit_status: string | null;
  national_account: boolean;
  last_activity_at: string | null;
  last_communicated_at: string | null;
  state: LifecycleState;
  days_left: number | null;
}

export const LIST_COLUMNS =
  "id, name, status, stage, industry, owner_id, owner_name, owner_location, " +
  "billing_city, billing_state, phone_e164, website, parent_account_name, child_count, " +
  "contact_count, credit_limit, credit_status, national_account, last_activity_at, " +
  "last_communicated_at, state, days_left, urgency";

/**
 * PostgREST parses `,` `.` `(` `)` as structure inside a filter value, so an
 * unescaped search term can change what a filter MEANS rather than merely
 * failing to match. Stripped rather than escaped -- nobody searches a company
 * book for a bare parenthesis, and silently dropping the character beats
 * returning a 400 to someone who typed "Smith & Sons, Inc.".
 */
function safeTerm(value: string): string {
  return value.replace(/[,()*\\%]/g, " ").trim();
}

/**
 * Minimal shape of the bits of the Supabase query builder this uses.
 *
 * The real PostgrestFilterBuilder type is enormous and recursive; constraining
 * the generic below to it makes the compiler give up with "type instantiation
 * is excessively deep". Narrowing to the seven methods actually called, and
 * casting at the boundary, keeps the call sites fully typed without asking TS
 * to unify anything.
 */
type Filterable = {
  eq: (c: string, v: unknown) => Filterable;
  is: (c: string, v: unknown) => Filterable;
  gt: (c: string, v: unknown) => Filterable;
  lt: (c: string, v: unknown) => Filterable;
  in: (c: string, v: readonly unknown[]) => Filterable;
  ilike: (c: string, v: string) => Filterable;
  not: (c: string, op: string, v: unknown) => Filterable;
  or: (f: string) => Filterable;
  order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => Filterable;
  range: (from: number, to: number) => Filterable;
};

export function applyAccountFilters<T>(query: T, f: AccountFilters, myId: string | null): T {
  let q = query as Filterable;

  if (f.q) {
    const term = safeTerm(f.q);
    if (term) {
      // Name first because it is what people mean, but city and street are
      // included so "Charlotte" and a street name both find something. Website
      // catches the case where somebody pastes a domain out of an email.
      q = q.or(
        [
          `name.ilike.%${term}%`,
          `website.ilike.%${term}%`,
          `billing_city.ilike.%${term}%`,
          `billing_street.ilike.%${term}%`,
        ].join(","),
      );
    }
  }

  if (f.status) q = q.eq("status", f.status);

  if (f.state === "at-risk") q = q.in("state", ["warning", "expiring", "overdue"]);
  else if (f.state) q = q.eq("state", f.state);

  if (f.stage) q = q.eq("stage", f.stage);
  if (f.industry) q = q.eq("industry", f.industry);
  // ilike without wildcards is an exact, case-insensitive match -- "nc" and
  // "NC" are the same state, and a filter that misses half the book is worse
  // than no filter.
  if (f.billingState) q = q.ilike("billing_state", safeTerm(f.billingState));
  if (f.city) q = q.ilike("billing_city", safeTerm(f.city));
  if (f.owner) q = q.eq("owner_id", f.owner);
  if (f.ownerLocation) q = q.eq("owner_location", f.ownerLocation);
  if (f.creditStatus) q = q.eq("credit_status", f.creditStatus);
  if (f.national) q = q.eq("national_account", f.national === "yes");

  if (f.hierarchy === "parents") q = q.gt("child_count", 0);
  else if (f.hierarchy === "children") q = q.not("parent_account_id", "is", null);

  if (f.hasContacts === "yes") q = q.gt("contact_count", 0);
  else if (f.hasContacts === "no") q = q.eq("contact_count", 0);

  if (f.idle === "none") {
    q = q.is("last_activity_at", null);
  } else if (f.idle) {
    const days = Number.parseInt(f.idle, 10);
    if (Number.isFinite(days)) {
      q = q.lt("last_activity_at", new Date(Date.now() - days * 86_400_000).toISOString());
    }
  }

  if (f.mine && myId) q = q.eq("owner_id", myId);
  if (f.unowned) q = q.is("owner_id", null);

  return applySort(q, f) as unknown as T;
}

function applySort(q: Filterable, f: AccountFilters): Filterable {
  switch (f.sort) {
    case "name":
      return q.order("name", { ascending: true });
    case "recent":
      return q.order("last_activity_at", { ascending: false, nullsFirst: false });
    case "stale":
      // Nulls first: an account nobody has ever had a qualifying conversation
      // with is the stalest thing in the book, not missing data.
      return q.order("last_activity_at", { ascending: true, nullsFirst: true });
    case "days_left":
      return q.order("days_left", { ascending: true, nullsFirst: false });
    case "credit":
      return q.order("credit_limit", { ascending: false, nullsFirst: false });
    case "city":
      return q
        .order("billing_state", { ascending: true, nullsFirst: false })
        .order("billing_city", { ascending: true, nullsFirst: false });
    case "urgency":
    default:
      return q
        .order("urgency", { ascending: true })
        .order("days_left", { ascending: true, nullsFirst: false })
        .order("name", { ascending: true });
  }
}

/**
 * The half-open row range for a page.
 *
 * Takes the size rather than reading the constant, so the row count somebody
 * chose on screen is the row count the query asks for. When it read the
 * constant, changing the setting changed the pager and not the query -- which
 * shows up as a page of fifty rows labelled "1-200 of 812".
 */
export function pageRange(page: number, size: number = PAGE_SIZE): [number, number] {
  const from = (Math.max(page, 1) - 1) * size;
  return [from, from + size - 1];
}
