"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DB_UNCONFIGURED, schema, tryGetDb } from "@/lib/db";
import { qualify, toRule } from "@/lib/qualify";
import { toE164 } from "@/lib/phone";
import { currentUser } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { STAGES, type Stage } from "./stages";

/**
 * A server action logs with console, not with pino.
 *
 * A logging framework in a serverless action is a dependency initialised on
 * every cold start to write one line that Vercel captures from stdout either
 * way. It earns nothing here, and an action that throws for ANY reason reports
 * itself to the user as "the specific message is omitted in production builds"
 * -- so the cheapest thing to do with a dependency that buys nothing is to
 * remove it rather than rule it out.
 *
 * The worker and the webhook keep pino. They run outside a request, their
 * output is searched by field, and nobody is staring at a button waiting for
 * them.
 */
const log = {
  info: (data: unknown, message: string) => console.log(message, data),
  error: (data: unknown, message: string) => console.error(message, data),
};

/*
 * Imported, never re-exported.
 *
 * A "use server" file may export async functions and NOTHING else -- every
 * export becomes a callable server reference, and a plain array has no meaning
 * as one. This file used to declare STAGES itself, and Next refused the whole
 * module at runtime with "A use server file can only export async functions,
 * found object". The build succeeded and every screen rendered; only buttons
 * broke, everywhere, because the dock that needs this list is on every page.
 *
 * Re-exporting it from here would fail in exactly the same way. Components
 * import it from ./stages directly.
 */

export interface DockCall {
  id: string;
  accountId: string | null;
  accountName: string | null;
  contactName: string | null;
  phone: string | null;
  direction: string | null;
  durationSeconds: number | null;
  result: string | null;
  occurredAt: string;
  loggedAt: string | null;
  stageOutcome: string | null;
  qualifies: boolean;
  qualificationReason: string;
}

/**
 * The caller's own recent calls.
 *
 * Unlogged first regardless of time, because an unlogged call is the only thing
 * on this list that needs doing. A call that has been written up is history.
 */
export async function recentCalls(limit = 40): Promise<DockCall[]> {
  // The dock renders on every screen. An empty list is a dock with nothing in
  // it; a throw is the screen behind it replaced by an error page.
  const db = tryGetDb();
  if (!db) return [];
  const user = await currentUser();
  if (!user) return [];

  const rows = await db
    .select({
      id: schema.activities.id,
      accountId: schema.activities.accountId,
      accountName: schema.accounts.name,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
      phone: schema.contacts.phoneE164,
      direction: schema.activities.direction,
      durationSeconds: schema.activities.durationSeconds,
      result: schema.activities.result,
      occurredAt: schema.activities.occurredAt,
      loggedAt: schema.activities.loggedAt,
      stageOutcome: schema.activities.stageOutcome,
      qualifies: schema.activities.qualifies,
      qualificationReason: schema.activities.qualificationReason,
    })
    .from(schema.activities)
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.activities.accountId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.activities.contactId))
    .where(and(eq(schema.activities.type, "call"), eq(schema.activities.userId, user.id)))
    .orderBy(sql`(${schema.activities.loggedAt} is not null)`, desc(schema.activities.occurredAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    contactName: r.contactFirst ? `${r.contactFirst} ${r.contactLast}`.trim() : null,
    phone: r.phone,
    direction: r.direction,
    durationSeconds: r.durationSeconds,
    result: r.result,
    occurredAt: r.occurredAt.toISOString(),
    loggedAt: r.loggedAt?.toISOString() ?? null,
    stageOutcome: r.stageOutcome,
    qualifies: r.qualifies,
    qualificationReason: r.qualificationReason,
  }));
}

export interface MatchOptions {
  accounts: { id: string; name: string; contactCount: number }[];
  contacts: { id: string; accountId: string; label: string; detail: string }[];
}

/**
 * Which companies and contacts hold this number.
 *
 * Drives the two dropdowns. Every candidate is returned rather than one being
 * guessed at: a number genuinely can sit at two customers, and several contacts
 * genuinely can share one switchboard with different extensions, different
 * emails, or nothing at all to tell them apart. The broker who just made the
 * call knows which; this code does not.
 */
export async function matchOptions(rawPhone: string): Promise<MatchOptions> {
  const db = tryGetDb();
  if (!db) return { accounts: [], contacts: [] };
  const phone = toE164(rawPhone);
  if (!phone) return { accounts: [], contacts: [] };

  const rows = await db
    .select({
      contactId: schema.contacts.id,
      accountId: schema.accounts.id,
      accountName: schema.accounts.name,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      title: schema.contacts.title,
      email: schema.contacts.email,
      type: schema.contacts.type,
    })
    .from(schema.contacts)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.contacts.accountId))
    .where(eq(schema.contacts.phoneE164, phone))
    .orderBy(schema.accounts.name, schema.contacts.lastName);

  const byAccount = new Map<string, { id: string; name: string; contactCount: number }>();
  for (const r of rows) {
    const existing = byAccount.get(r.accountId);
    if (existing) existing.contactCount += 1;
    else byAccount.set(r.accountId, { id: r.accountId, name: r.accountName, contactCount: 1 });
  }

  return {
    accounts: [...byAccount.values()],
    contacts: rows.map((r) => ({
      id: r.contactId,
      accountId: r.accountId,
      label: `${r.firstName} ${r.lastName}`.trim(),
      // Whatever distinguishes otherwise-identical rows. When nothing does, the
      // broker picks the first and that is genuinely fine.
      detail: [r.title, r.type, r.email].filter(Boolean).join(" · ") || "no other details on file",
    })),
  };
}

export interface LogResult {
  ok?: true;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Write up a call.
 *
 * All four fields are required, and they are checked here rather than trusted
 * from the form — a required attribute in markup is a courtesy to the browser,
 * not a rule. The database carries the same constraint underneath, so a
 * half-filled log cannot exist by any route.
 *
 * Saving is what makes the call count: the qualifier refuses a call with no
 * stage outcome, so this is the moment a 90-second conversation turns into an
 * approved activity and resets the account's clock.
 */
export async function logCall(_prev: LogResult, form: FormData): Promise<LogResult> {
  const db = tryGetDb();
  if (!db) return { error: DB_UNCONFIGURED };
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const activityId = String(form.get("activityId") ?? "");
  const accountId = String(form.get("accountId") ?? "");
  const contactId = String(form.get("contactId") ?? "");
  const notes = String(form.get("notes") ?? "").trim();
  const stage = String(form.get("stageOutcome") ?? "");

  const fieldErrors: Record<string, string> = {};
  if (!accountId) fieldErrors.accountId = "Pick the company.";
  if (!contactId) fieldErrors.contactId = "Pick who you spoke to.";
  if (!notes) fieldErrors.notes = "Notes are required.";
  if (!STAGES.includes(stage as Stage)) fieldErrors.stageOutcome = "Pick a stage.";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  if (!activityId) return { error: "No call selected." };

  const [call] = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.id, activityId))
    .limit(1);
  if (!call) return { error: "That call no longer exists." };

  const [rule] = await db
    .select()
    .from(schema.qualificationRules)
    .where(
      and(
        eq(schema.qualificationRules.activityType, "call"),
        eq(schema.qualificationRules.active, true),
      ),
    )
    .limit(1);

  // Re-run qualification now that the outcome exists. Until this moment the
  // call sat with "not yet logged" as its reason.
  const verdict = qualify(
    {
      type: "call",
      durationSeconds: call.durationSeconds,
      result: call.result,
      direction: (call.direction ?? null) as "inbound" | "outbound" | null,
      stageOutcome: stage,
    },
    rule ? toRule(rule) : null,
  );

  await db
    .update(schema.activities)
    .set({
      accountId,
      contactId,
      notes,
      stageOutcome: stage,
      loggedBy: user.id,
      loggedAt: new Date(),
      qualifies: verdict.qualifies,
      qualificationReason: verdict.reason,
    })
    .where(eq(schema.activities.id, activityId));

  log.info(
    { activityId, accountId, stage, by: user.id, qualifies: verdict.qualifies },
    "call logged",
  );

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
}

/**
 * Place a call.
 *
 * RingCentral's click-to-call rings the broker's own handset first, then dials
 * the customer. Without credentials there is nothing to ring, so this reports
 * that plainly instead of appearing to work.
 */
export async function placeCall(rawPhone: string): Promise<{ ok?: true; error?: string }> {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const phone = toE164(rawPhone);
  if (!phone) return { error: "That number cannot be dialled. Check the area code." };

  if (!env.ringCentralConfigured) {
    return {
      error:
        "RingCentral is not connected yet. Add RC_CLIENT_ID, RC_CLIENT_SECRET and RC_JWT " +
        "to switch the dialler on.",
    };
  }

  try {
    const { rcToken } = await import("@/lib/ringcentral/client");
    const token = await rcToken();
    const res = await fetch(`${env.RC_SERVER}/restapi/v1.0/account/~/telephony/call-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { deviceId: user.id },
        to: { phoneNumber: phone },
      }),
    });
    if (!res.ok) return { error: `RingCentral refused the call (${res.status}).` };
    return { ok: true };
  } catch (err) {
    log.error({ err }, "click-to-call failed");
    return { error: "Could not reach RingCentral." };
  }
}

/** Calls the caller has not written up yet. Drives the dock's badge. */
export async function unloggedCount(): Promise<number> {
  const db = tryGetDb();
  if (!db) return 0;
  const user = await currentUser();
  if (!user) return 0;
  const rows = await db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.type, "call"),
        eq(schema.activities.userId, user.id),
        isNull(schema.activities.loggedAt),
      ),
    );
  return rows.length;
}
