/**
 * Account ownership: claiming, holding, losing.
 *
 * The mechanic this CRM exists for. A broker holds a prospect. If they do not
 * work it, it expires and returns to a pool anyone can claim from. "Working it"
 * means qualifying activity, which the qualifier already defines -- so the
 * question "did that call count" and the question "does this broker keep the
 * account" have one answer, computed in one place.
 *
 * Three rules shape everything here:
 *
 *   1. THE DATABASE DECIDES WHO OWNS WHAT. Claiming is an UPDATE guarded by a
 *      trigger and a partial unique index, not a check in application code. Two
 *      brokers clicking Claim in the same second is a race, and races are won by
 *      constraints rather than by whoever's request arrived first.
 *
 *   2. LOSING AN ACCOUNT IS AN EVENT, not a column going quiet. Every release
 *      writes to account_claims with a reason and a timestamp, because the
 *      question "who had this in March" is what a territory argument turns on.
 *
 *   3. STATE IS COMPUTED, NEVER STORED. account_state() in SQL is the only
 *      definition of amber and red. A cached copy would drift the moment an
 *      admin changed the thresholds, and the list would disagree with the
 *      detail page.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/matcher";

/**
 * Where an account stands.
 *
 *   available -- nobody owns it. Anyone can claim it.
 *   fresh     -- worked recently. Nothing to do.
 *   warning   -- amber. Still yours, but it needs attention.
 *   expiring  -- red. Days away from being taken.
 *   overdue   -- past the deadline, awaiting the nightly release.
 *
 * 'overdue' is deliberately visible rather than hidden. A broker should see an
 * account is gone before it disappears from their list; a row that silently
 * vanishes overnight is how a sales floor stops trusting the system.
 */
export type LifecycleState = "available" | "fresh" | "warning" | "expiring" | "overdue";

export type ReleaseReason = "expired" | "manual" | "reassigned" | "converted";

export interface LifecyclePresentation {
  label: string;
  /** Tailwind classes for the flag pill. */
  className: string;
  /** Plain-language explanation, for a tooltip or the detail page. */
  meaning: string;
}

/**
 * How each state is shown. Colour is never the only signal -- every flag also
 * carries a word, so the list stays readable to anyone who cannot distinguish
 * the reds and ambers.
 */
export const LIFECYCLE: Record<LifecycleState, LifecyclePresentation> = {
  available: {
    label: "Available",
    className: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
    meaning: "Unclaimed. Any broker can take this one.",
  },
  fresh: {
    label: "Active",
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    meaning: "Worked recently. Nothing needed.",
  },
  warning: {
    label: "Needs attention",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    meaning: "Going quiet. Log a qualifying call to reset the clock.",
  },
  expiring: {
    label: "Expiring",
    className: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
    meaning: "Days away from returning to the available pool.",
  },
  overdue: {
    label: "Releasing",
    className: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
    meaning: "Past the deadline. Returns to the pool at the next nightly sweep.",
  },
};

/** Ordering for lists: the ones needing action first. */
export const URGENCY: Record<LifecycleState, number> = {
  overdue: 0,
  expiring: 1,
  warning: 2,
  fresh: 3,
  available: 4,
};

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && value in LIFECYCLE;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AccountWithState {
  id: string;
  name: string;
  status: string;
  industry: string | null;
  ownerId: string | null;
  ownerName: string | null;
  lastActivityAt: Date | null;
  claimedAt: Date | null;
  state: LifecycleState;
  /** Days until release. Negative once overdue, null when unowned. */
  daysLeft: number | null;
}

/**
 * The state columns, computed in SQL.
 *
 * Called from every list so the flag is always derived from the live thresholds
 * rather than from something written down earlier.
 */
const STATE_COLUMNS = {
  state: sql<LifecycleState>`account_state(${schema.accounts.ownerId}, ${schema.accounts.status}, ${schema.accounts.lastActivityAt}, ${schema.accounts.claimedAt})`,
  daysLeft: sql<number | null>`account_days_left(${schema.accounts.ownerId}, ${schema.accounts.status}, ${schema.accounts.lastActivityAt}, ${schema.accounts.claimedAt})`,
};

export async function accountsWithState(db: Db, limit = 200): Promise<AccountWithState[]> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      status: schema.accounts.status,
      industry: schema.accounts.industry,
      ownerId: schema.accounts.ownerId,
      ownerName: schema.users.fullName,
      lastActivityAt: schema.accounts.lastActivityAt,
      claimedAt: schema.accounts.claimedAt,
      ...STATE_COLUMNS,
    })
    .from(schema.accounts)
    .leftJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
    .limit(limit);

  return rows as AccountWithState[];
}

/** The unclaimed pool. */
export async function availableAccounts(db: Db, limit = 200): Promise<AccountWithState[]> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      status: schema.accounts.status,
      industry: schema.accounts.industry,
      ownerId: schema.accounts.ownerId,
      ownerName: sql<string | null>`null`,
      lastActivityAt: schema.accounts.lastActivityAt,
      claimedAt: schema.accounts.claimedAt,
      ...STATE_COLUMNS,
    })
    .from(schema.accounts)
    .where(isNull(schema.accounts.ownerId))
    .orderBy(sql`${schema.accounts.releasedAt} desc nulls last`)
    .limit(limit);

  return rows as AccountWithState[];
}

/** Every state for one account, for the detail page. */
export async function accountState(
  db: Db,
  accountId: string,
): Promise<{ state: LifecycleState; daysLeft: number | null } | null> {
  const [row] = await db
    .select(STATE_COLUMNS)
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1);
  return row ? { state: row.state, daysLeft: row.daysLeft } : null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type ClaimResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "already_claimed" | "not_found" | "denied"; detail: string };

/**
 * Take an unowned account.
 *
 * The `isNull(ownerId)` in the WHERE clause is the whole race protection: two
 * brokers clicking at the same moment both issue this UPDATE, and exactly one
 * matches a row. The loser gets zero rows back and is told the truth, rather
 * than both being told they succeeded and one quietly losing the account later.
 */
export async function claimAccount(
  db: Db,
  accountId: string,
  userId: string,
): Promise<ClaimResult> {
  const claimed = await db
    .update(schema.accounts)
    .set({ ownerId: userId, lastReleaseReason: null })
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.ownerId)))
    .returning({ id: schema.accounts.id });

  if (claimed.length > 0) return { ok: true, accountId: claimed[0].id };

  // Nothing matched. Work out which of the two reasons it was, so the message
  // is useful rather than "could not claim".
  const [existing] = await db
    .select({ ownerId: schema.accounts.ownerId, ownerName: schema.users.fullName })
    .from(schema.accounts)
    .leftJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
    .where(eq(schema.accounts.id, accountId))
    .limit(1);

  if (!existing) {
    return { ok: false, reason: "not_found", detail: "That account no longer exists." };
  }
  return {
    ok: false,
    reason: "already_claimed",
    detail: existing.ownerName
      ? `${existing.ownerName} claimed this one first.`
      : "Another broker claimed this one first.",
  };
}

/** Give an account back to the pool. */
export async function releaseAccount(
  db: Db,
  accountId: string,
  reason: ReleaseReason = "manual",
): Promise<{ ok: boolean }> {
  const released = await db
    .update(schema.accounts)
    // last_release_reason is set in the SAME statement so the trigger that
    // closes the claim row can read it. Setting it afterwards would record the
    // release with a guessed reason.
    .set({ ownerId: null, lastReleaseReason: reason })
    .where(eq(schema.accounts.id, accountId))
    .returning({ id: schema.accounts.id });

  return { ok: released.length > 0 };
}

export interface SweepResult {
  released: { accountId: string; name: string; ownerId: string | null }[];
}

/**
 * The nightly sweep: return every overdue account to the pool.
 *
 * Runs under the service role, because it acts on accounts belonging to
 * everyone. Selecting first and updating by id keeps the set of affected rows
 * knowable -- the job reports exactly which accounts it took and from whom,
 * which is what makes the next morning's conversation possible.
 */
export async function releaseOverdueAccounts(db: Db): Promise<SweepResult> {
  const overdue = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      ownerId: schema.accounts.ownerId,
      ...STATE_COLUMNS,
    })
    .from(schema.accounts)
    .where(sql`account_state(${schema.accounts.ownerId}, ${schema.accounts.status}, ${schema.accounts.lastActivityAt}, ${schema.accounts.claimedAt}) = 'overdue'`);

  const released: SweepResult["released"] = [];
  for (const account of overdue) {
    const result = await releaseAccount(db, account.id, "expired");
    if (result.ok) {
      released.push({ accountId: account.id, name: account.name, ownerId: account.ownerId });
    }
  }
  return { released };
}

/** The history of who has held an account. Backs the detail page's audit list. */
export async function claimHistory(db: Db, accountId: string, limit = 20) {
  return db
    .select({
      id: schema.accountClaims.id,
      userId: schema.accountClaims.userId,
      userName: schema.users.fullName,
      claimedAt: schema.accountClaims.claimedAt,
      releasedAt: schema.accountClaims.releasedAt,
      releaseReason: schema.accountClaims.releaseReason,
    })
    .from(schema.accountClaims)
    .leftJoin(schema.users, eq(schema.users.id, schema.accountClaims.userId))
    .where(eq(schema.accountClaims.accountId, accountId))
    .orderBy(sql`${schema.accountClaims.claimedAt} desc`)
    .limit(limit);
}
