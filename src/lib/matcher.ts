/**
 * Matching a captured call to a customer, and deciding whether it counts.
 *
 * This is the heart of the system, so the shape is deliberate:
 *
 *   * All the logic lives here as ordinary functions taking a database handle.
 *     The Inngest job in src/inngest/ is a thin wrapper that supplies retries
 *     and step boundaries. That means the whole pipeline is testable without a
 *     job runner, a webhook, or a network.
 *
 *   * Ambiguity is never resolved by guessing. A number that appears at two
 *     accounts produces one review-queue row and zero activities. Attaching a
 *     call to the wrong customer is far more expensive than asking a human.
 *
 *   * Every exit produces a record. Matched, unmatched, ambiguous, duplicate --
 *     each one leaves something behind that explains itself.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { toE164 } from "@/lib/phone";
import { qualify, toRule, type ActivityType, type Direction } from "@/lib/qualify";

/** Works against Supabase in production and PGlite in tests. */
export type Db = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedCall {
  /** Stable provider identifier. Also the idempotency key. */
  externalId: string | null;
  /** The number on the other end -- the one belonging to the customer. */
  counterpartyNumber: string | null;
  /** The number belonging to us. Never used for matching. */
  ourNumber: string | null;
  direction: Direction;
  durationSeconds: number | null;
  /** Provider outcome verbatim. */
  result: string | null;
  occurredAt: Date;
  /** Telephony extension that handled the call, if the payload names one. */
  extensionId: string | null;
  subject: string | null;
}

/** Narrowing helpers -- webhook payloads are `unknown` until proven otherwise. */
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Turn a RingCentral webhook payload into a ParsedCall.
 *
 * Two payload shapes are accepted, because RingCentral has two relevant event
 * families and they carry different information:
 *
 *   Call Log Sync -- carries `duration`, `result`, `from`, `to`. This is what a
 *     CRM should subscribe to, because it is the only one that knows how long
 *     the call ran and how it ended.
 *
 *   Telephony Session -- carries `parties[]` and `telephonySessionId`. It fires
 *     earlier and is what the build plan names for idempotency, but a session
 *     event on its own cannot answer "did this qualify".
 *
 * Call-log fields win when both are present. Returns null when the payload is
 * not a call at all, which the caller treats as an unparseable event rather
 * than a match failure.
 */
export function parseCall(payload: unknown): ParsedCall | null {
  const root = obj(payload);
  if (!root) return null;
  const body = obj(root.body) ?? root;

  // Call Log Sync nests the interesting records a couple of levels down.
  const changes = Array.isArray(body.changes) ? body.changes : null;
  const fromChanges = changes
    ? changes.flatMap((c) => {
        const rec = obj(c);
        const list = rec && Array.isArray(rec.newRecords) ? rec.newRecords : [];
        return list.map(obj).filter(Boolean) as Record<string, unknown>[];
      })
    : [];

  const record = fromChanges[0] ?? body;

  const externalId =
    str(record.telephonySessionId) ??
    str(body.telephonySessionId) ??
    str(record.sessionId) ??
    str(record.id) ??
    str(root.uuid);

  const direction = normalizeDirection(str(record.direction));

  // A telephony-session payload keeps the numbers inside parties[].
  const parties = Array.isArray(body.parties) ? body.parties.map(obj).filter(Boolean) : [];
  const party = (parties[0] ?? null) as Record<string, unknown> | null;

  const fromNumber =
    str(obj(record.from)?.phoneNumber) ?? str(obj(party?.from)?.phoneNumber) ?? null;
  const toNumber = str(obj(record.to)?.phoneNumber) ?? str(obj(party?.to)?.phoneNumber) ?? null;

  const partyDirection = direction ?? normalizeDirection(str(party?.direction));

  // On an outbound call the customer is who we dialled; on an inbound call the
  // customer is who dialled us. Getting this backwards matches every call to
  // our own main line.
  const counterpartyNumber = partyDirection === "inbound" ? fromNumber : toNumber;
  const ourNumber = partyDirection === "inbound" ? toNumber : fromNumber;

  const result =
    str(record.result) ?? str(obj(party?.status)?.code) ?? str(obj(body.status)?.code) ?? null;

  const startTime =
    str(record.startTime) ?? str(body.eventTime) ?? str(root.timestamp) ?? null;

  const extensionId =
    str(obj(record.extension)?.id) ??
    str(record.extensionId) ??
    str(party?.extensionId) ??
    str(obj(party?.extension)?.id) ??
    null;

  // A call with no identifiable counterparty is not a call we can act on.
  if (!counterpartyNumber && !fromNumber && !toNumber) return null;

  return {
    externalId,
    counterpartyNumber: counterpartyNumber ?? fromNumber ?? toNumber,
    ourNumber,
    direction: partyDirection,
    durationSeconds: num(record.duration) ?? num(body.duration),
    result,
    occurredAt: startTime ? new Date(startTime) : new Date(),
    extensionId,
    subject: str(record.subject),
  };
}

function normalizeDirection(value: string | null): Direction {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "inbound") return "inbound";
  if (v === "outbound") return "outbound";
  return null;
}

/** The email counterpart. Same pipeline, keyed on address instead of number. */
export interface ParsedEmail {
  externalId: string | null;
  counterpartyEmail: string | null;
  direction: Direction;
  subject: string | null;
  occurredAt: Date;
}

export function parseEmail(payload: unknown): ParsedEmail | null {
  const root = obj(payload);
  if (!root) return null;
  const body = obj(root.body) ?? root;

  const direction = normalizeDirection(str(body.direction)) ?? "outbound";
  const from = str(body.from);
  const to = Array.isArray(body.to) ? str(body.to[0]) : str(body.to);
  const counterparty = direction === "inbound" ? from : to;
  if (!counterparty) return null;

  const sent = str(body.sentAt) ?? str(body.date) ?? str(root.timestamp);
  return {
    externalId: str(body.messageId) ?? str(body.id) ?? str(root.uuid),
    counterpartyEmail: counterparty.trim().toLowerCase(),
    direction,
    subject: str(body.subject),
    occurredAt: sent ? new Date(sent) : new Date(),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface ContactMatch {
  id: string;
  accountId: string;
  firstName: string;
  lastName: string;
}

/**
 * Every contact holding this number.
 *
 * The comparison is a plain equality test against an already-normalized column,
 * which is what lets it use contacts_phone_idx. Normalizing inside the query
 * would defeat the index and turn every inbound call into a table scan.
 */
export async function findContactsByPhone(db: Db, phoneE164: string): Promise<ContactMatch[]> {
  const rows = await db
    .select({
      id: schema.contacts.id,
      accountId: schema.contacts.accountId,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.phoneE164, phoneE164));
  return rows;
}

/** Same idea for email. Case-insensitive, matching contacts_email_idx. */
export async function findContactsByEmail(db: Db, email: string): Promise<ContactMatch[]> {
  const rows = await db
    .select({
      id: schema.contacts.id,
      accountId: schema.contacts.accountId,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
    })
    .from(schema.contacts)
    .where(sql`lower(${schema.contacts.email}) = ${email.toLowerCase()}`);
  return rows;
}

async function activeRule(db: Db, type: ActivityType) {
  const [row] = await db
    .select()
    .from(schema.qualificationRules)
    .where(
      and(
        eq(schema.qualificationRules.activityType, type),
        eq(schema.qualificationRules.active, true),
      ),
    )
    .limit(1);
  return row ? toRule(row) : null;
}

/**
 * Which rep gets credit. The extension that handled the call, when we know it;
 * otherwise the account owner, because an unattributed call on an account is
 * still that account owner's business.
 */
async function resolveUserId(
  db: Db,
  extensionId: string | null,
  accountId: string,
): Promise<string | null> {
  if (extensionId) {
    const [byExtension] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.rcExtensionId, extensionId))
      .limit(1);
    if (byExtension) return byExtension.id;
  }
  const [account] = await db
    .select({ ownerId: schema.accounts.ownerId })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1);
  return account?.ownerId ?? null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ProcessOutcome =
  | { status: "matched"; activityId: string; accountId: string; qualifies: boolean; reason: string }
  | { status: "duplicate"; activityId: string | null }
  | { status: "unmatched"; reason: UnmatchedReason; unmatchedId: string | null }
  | { status: "already_processed" }
  | { status: "unparseable"; detail: string };

export type UnmatchedReason =
  | "no_contact_match"
  | "multiple_accounts"
  | "unusable_phone_number"
  | "unusable_email_address";

/**
 * Take one stored raw event all the way to its conclusion.
 *
 * Safe to call more than once for the same event: the guards at the top and the
 * unique indexes underneath make a repeat run a no-op rather than a second
 * activity. That property is what lets the job runner retry freely.
 */
export async function processRawEvent(db: Db, rawEventId: string): Promise<ProcessOutcome> {
  const [raw] = await db
    .select()
    .from(schema.rawEvents)
    .where(eq(schema.rawEvents.id, rawEventId))
    .limit(1);

  if (!raw) return { status: "unparseable", detail: `raw_event ${rawEventId} not found` };
  if (raw.processedAt) return { status: "already_processed" };

  const outcome =
    raw.source === "email"
      ? await processEmailEvent(db, raw)
      : await processCallEvent(db, raw);

  await db
    .update(schema.rawEvents)
    .set({
      processedAt: new Date(),
      error: outcome.status === "unparseable" ? outcome.detail : null,
    })
    .where(eq(schema.rawEvents.id, rawEventId));

  return outcome;
}

async function processCallEvent(
  db: Db,
  raw: typeof schema.rawEvents.$inferSelect,
): Promise<ProcessOutcome> {
  const call = parseCall(raw.payload);
  if (!call) return { status: "unparseable", detail: "payload is not a recognisable call event" };

  const phone = toE164(call.counterpartyNumber);
  if (!phone) {
    // Withheld caller ID, a malformed number, or a seven-digit local number.
    // It goes to the queue rather than being guessed at.
    return recordUnmatched(db, raw.id, "unusable_phone_number", {
      phone: call.counterpartyNumber,
      occurredAt: call.occurredAt,
      direction: call.direction,
      durationSeconds: call.durationSeconds,
      result: call.result,
    });
  }

  const matches = await findContactsByPhone(db, phone);
  if (matches.length === 0) {
    return recordUnmatched(db, raw.id, "no_contact_match", {
      phone,
      occurredAt: call.occurredAt,
      direction: call.direction,
      durationSeconds: call.durationSeconds,
      result: call.result,
    });
  }

  const accountIds = [...new Set(matches.map((m) => m.accountId))];
  if (accountIds.length > 1) {
    // The same number sits at two customers -- a shared switchboard, a reused
    // mobile, or dirty data. A human decides; the system does not.
    return recordUnmatched(db, raw.id, "multiple_accounts", {
      phone,
      occurredAt: call.occurredAt,
      direction: call.direction,
      durationSeconds: call.durationSeconds,
      result: call.result,
      candidateAccountIds: accountIds,
    });
  }

  const contact = matches[0];
  const rule = await activeRule(db, "call");
  const verdict = qualify(
    {
      type: "call",
      durationSeconds: call.durationSeconds,
      result: call.result,
      direction: call.direction,
    },
    rule,
  );

  const userId = await resolveUserId(db, call.extensionId, contact.accountId);

  const inserted = await db
    .insert(schema.activities)
    .values({
      accountId: contact.accountId,
      contactId: contact.id,
      userId,
      type: "call",
      direction: call.direction,
      subject: call.subject ?? defaultCallSubject(call, contact),
      occurredAt: call.occurredAt,
      durationSeconds: call.durationSeconds,
      result: call.result,
      source: raw.source,
      externalId: call.externalId,
      qualifies: verdict.qualifies,
      qualificationReason: verdict.reason,
      rawEventId: raw.id,
    })
    // The unique index on (source, external_id) is the idempotency guarantee.
    // Providers redeliver; a redelivery must not become a second activity.
    .onConflictDoNothing()
    .returning({ id: schema.activities.id });

  if (inserted.length === 0) {
    const existing = call.externalId
      ? await db
          .select({ id: schema.activities.id })
          .from(schema.activities)
          .where(
            and(
              eq(schema.activities.source, raw.source),
              eq(schema.activities.externalId, call.externalId),
            ),
          )
          .limit(1)
      : [];
    return { status: "duplicate", activityId: existing[0]?.id ?? null };
  }

  return {
    status: "matched",
    activityId: inserted[0].id,
    accountId: contact.accountId,
    qualifies: verdict.qualifies,
    reason: verdict.reason,
  };
}

async function processEmailEvent(
  db: Db,
  raw: typeof schema.rawEvents.$inferSelect,
): Promise<ProcessOutcome> {
  const mail = parseEmail(raw.payload);
  if (!mail) return { status: "unparseable", detail: "payload is not a recognisable email event" };
  if (!mail.counterpartyEmail) {
    return recordUnmatched(db, raw.id, "unusable_email_address", {
      email: null,
      occurredAt: mail.occurredAt,
      direction: mail.direction,
    });
  }

  const matches = await findContactsByEmail(db, mail.counterpartyEmail);
  if (matches.length === 0) {
    return recordUnmatched(db, raw.id, "no_contact_match", {
      email: mail.counterpartyEmail,
      occurredAt: mail.occurredAt,
      direction: mail.direction,
      subject: mail.subject,
    });
  }

  const accountIds = [...new Set(matches.map((m) => m.accountId))];
  if (accountIds.length > 1) {
    return recordUnmatched(db, raw.id, "multiple_accounts", {
      email: mail.counterpartyEmail,
      occurredAt: mail.occurredAt,
      direction: mail.direction,
      subject: mail.subject,
      candidateAccountIds: accountIds,
    });
  }

  const contact = matches[0];
  const rule = await activeRule(db, "email");
  const verdict = qualify(
    { type: "email", durationSeconds: null, result: null, direction: mail.direction },
    rule,
  );
  const userId = await resolveUserId(db, null, contact.accountId);

  const inserted = await db
    .insert(schema.activities)
    .values({
      accountId: contact.accountId,
      contactId: contact.id,
      userId,
      type: "email",
      direction: mail.direction,
      subject: mail.subject ?? "(no subject)",
      occurredAt: mail.occurredAt,
      source: raw.source,
      externalId: mail.externalId,
      qualifies: verdict.qualifies,
      qualificationReason: verdict.reason,
      rawEventId: raw.id,
    })
    .onConflictDoNothing()
    .returning({ id: schema.activities.id });

  if (inserted.length === 0) return { status: "duplicate", activityId: null };

  return {
    status: "matched",
    activityId: inserted[0].id,
    accountId: contact.accountId,
    qualifies: verdict.qualifies,
    reason: verdict.reason,
  };
}

function defaultCallSubject(call: ParsedCall, contact: ContactMatch): string {
  const who = `${contact.firstName} ${contact.lastName}`.trim();
  const dir = call.direction === "inbound" ? "Inbound call from" : "Outbound call to";
  return `${dir} ${who}`;
}

interface UnmatchedDetails {
  phone?: string | null;
  email?: string | null;
  occurredAt?: Date | null;
  direction?: Direction;
  durationSeconds?: number | null;
  result?: string | null;
  subject?: string | null;
  candidateAccountIds?: string[];
}

/**
 * File an event for human review.
 *
 * The unique index on raw_event_id means a redelivered webhook updates nothing
 * and creates nothing -- the queue shows one row per real problem, not one row
 * per delivery attempt.
 */
export async function recordUnmatched(
  db: Db,
  rawEventId: string,
  reason: UnmatchedReason,
  details: UnmatchedDetails = {},
): Promise<ProcessOutcome> {
  const inserted = await db
    .insert(schema.unmatchedActivities)
    .values({
      rawEventId,
      reason,
      phoneE164: details.phone ?? null,
      email: details.email ?? null,
      direction: details.direction ?? null,
      durationSeconds: details.durationSeconds ?? null,
      result: details.result ?? null,
      subject: details.subject ?? null,
      occurredAt: details.occurredAt ?? null,
      candidateAccountIds: details.candidateAccountIds ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.unmatchedActivities.id });

  return { status: "unmatched", reason, unmatchedId: inserted[0]?.id ?? null };
}

/**
 * Resolve a queued item: an admin has said which account it belongs to.
 *
 * The activity is created and the queue row is stamped, so the audit trail runs
 * raw event -> queue row -> who resolved it -> resulting activity.
 */
export async function resolveUnmatched(
  db: Db,
  unmatchedId: string,
  accountId: string,
  resolvedBy: string,
): Promise<{ activityId: string } | { error: string }> {
  const [row] = await db
    .select()
    .from(schema.unmatchedActivities)
    .where(
      and(eq(schema.unmatchedActivities.id, unmatchedId), isNull(schema.unmatchedActivities.resolvedAt)),
    )
    .limit(1);

  if (!row) return { error: "queue item not found, or already resolved" };

  const [raw] = await db
    .select()
    .from(schema.rawEvents)
    .where(eq(schema.rawEvents.id, row.rawEventId))
    .limit(1);

  const isEmail = raw?.source === "email";
  const type: ActivityType = isEmail ? "email" : "call";
  const rule = await activeRule(db, type);
  const verdict = qualify(
    {
      type,
      durationSeconds: row.durationSeconds,
      result: row.result,
      direction: (row.direction ?? null) as Direction,
    },
    rule,
  );

  // Try to attach the contact too, now that the account is known. A number that
  // matched nothing may still belong to a known contact at this account.
  let contactId: string | null = null;
  if (row.phoneE164) {
    const candidates = await findContactsByPhone(db, row.phoneE164);
    contactId = candidates.find((c) => c.accountId === accountId)?.id ?? null;
  } else if (row.email) {
    const candidates = await findContactsByEmail(db, row.email);
    contactId = candidates.find((c) => c.accountId === accountId)?.id ?? null;
  }

  const parsed = raw ? (isEmail ? null : parseCall(raw.payload)) : null;
  const userId = await resolveUserId(db, parsed?.extensionId ?? null, accountId);

  const [activity] = await db
    .insert(schema.activities)
    .values({
      accountId,
      contactId,
      userId,
      type,
      direction: row.direction,
      subject: row.subject ?? `${type === "call" ? "Call" : "Email"} resolved from review queue`,
      occurredAt: row.occurredAt ?? new Date(),
      durationSeconds: row.durationSeconds,
      result: row.result,
      source: raw?.source ?? "manual",
      // externalId is deliberately left null. The original identifier may
      // already sit on a different activity; reusing it here would trip the
      // idempotency index and silently drop the resolution.
      externalId: null,
      qualifies: verdict.qualifies,
      qualificationReason: `${verdict.reason} (resolved from review queue)`,
      rawEventId: row.rawEventId,
    })
    .returning({ id: schema.activities.id });

  await db
    .update(schema.unmatchedActivities)
    .set({
      resolvedAt: new Date(),
      resolvedBy,
      resolvedToAccountId: accountId,
      resolvedActivityId: activity.id,
    })
    .where(eq(schema.unmatchedActivities.id, unmatchedId));

  return { activityId: activity.id };
}

/** Open review-queue items, newest first. Backs screen 4. */
export async function openQueue(db: Db, limit = 100) {
  return db
    .select()
    .from(schema.unmatchedActivities)
    .where(isNull(schema.unmatchedActivities.resolvedAt))
    .orderBy(sql`${schema.unmatchedActivities.createdAt} desc`)
    .limit(limit);
}

/** Candidate accounts for an ambiguous item, so the queue can name them. */
export async function accountsByIds(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, ids));
}
