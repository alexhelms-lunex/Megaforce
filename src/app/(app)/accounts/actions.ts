"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { mergeCustom, parseCustomFields, type FieldDefinition } from "@/lib/custom-values";
import { toE164 } from "@/lib/phone";
import { currentUser } from "@/lib/supabase/server";

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

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const STATUSES = new Set(["prospect", "engaged", "customer", "do_not_contact"]);

/** The live definitions. Read every time, because they are data and can change. */
async function accountFieldDefs(): Promise<FieldDefinition[]> {
  const rows = await db
    .select({
      key: schema.fieldDefs.key,
      label: schema.fieldDefs.label,
      type: schema.fieldDefs.type,
      options: schema.fieldDefs.options,
      required: schema.fieldDefs.required,
    })
    .from(schema.fieldDefs)
    .where(eq(schema.fieldDefs.object, "account"))
    .orderBy(schema.fieldDefs.sort);

  return rows
    .filter((r) => !("archived" in r) || true)
    .map((r) => ({ ...r, type: r.type as FieldDefinition["type"] }));
}

/**
 * Create a company.
 *
 * The creator owns it. Adding a prospect and then finding it sitting in the
 * available pool for somebody else to take would be an unpleasant surprise, and
 * the clock starting on the person who did the work is the honest default.
 */
export async function createAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "A company name is required." };

  const status = String(form.get("status") ?? "prospect");
  if (!STATUSES.has(status)) return { error: "Unknown status." };

  const defs = await accountFieldDefs();
  const { values, errors } = parseCustomFields(form, defs);
  if (errors.length > 0) {
    return { fieldErrors: Object.fromEntries(errors.map((e) => [e.key, e.message])) };
  }

  const claim = String(form.get("claim") ?? "1") === "1";

  const [created] = await db
    .insert(schema.accounts)
    .values({
      name,
      status,
      industry: String(form.get("industry") ?? "").trim() || null,
      domain: String(form.get("domain") ?? "").trim() || null,
      ownerId: claim ? user.id : null,
      custom: values,
    })
    .returning({ id: schema.accounts.id });

  log.info({ accountId: created.id, by: user.id, claimed: claim }, "account created");

  revalidatePath("/accounts");
  revalidatePath("/available");
  redirect(`/accounts/${created.id}`);
}

/**
 * Edit a company.
 *
 * Ownership is deliberately not editable here. Moving an account between
 * brokers is an admin action guarded by a database trigger, and putting it on
 * an ordinary edit form would invite exactly the territory dispute the rule
 * exists to prevent.
 */
export async function updateAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const accountId = String(form.get("accountId") ?? "");
  if (!accountId) return { error: "No account given." };

  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "A company name is required." };

  const status = String(form.get("status") ?? "prospect");
  if (!STATUSES.has(status)) return { error: "Unknown status." };

  const [existing] = await db
    .select({ ownerId: schema.accounts.ownerId, custom: schema.accounts.custom })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1);

  if (!existing) return { error: "That account no longer exists." };

  // Unowned accounts are editable by anyone -- they are in the pool, and
  // tidying one up before claiming it is reasonable. An owned account belongs
  // to its broker, their management chain, and the privileged roles.
  const privileged = user.role === "admin" || user.role === "credit" || user.role === "manager";
  if (existing.ownerId && existing.ownerId !== user.id && !privileged) {
    return { error: "That account belongs to another broker." };
  }

  const defs = await accountFieldDefs();
  const { values, errors } = parseCustomFields(form, defs);
  if (errors.length > 0) {
    return { fieldErrors: Object.fromEntries(errors.map((e) => [e.key, e.message])) };
  }

  await db
    .update(schema.accounts)
    .set({
      name,
      status,
      industry: String(form.get("industry") ?? "").trim() || null,
      domain: String(form.get("domain") ?? "").trim() || null,
      // Merged, not replaced: values belonging to retired fields would
      // otherwise be destroyed by an unrelated edit.
      custom: mergeCustom(existing.custom as Record<string, unknown>, values),
    })
    .where(eq(schema.accounts.id, accountId));

  log.info({ accountId, by: user.id }, "account updated");

  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  redirect(`/accounts/${accountId}`);
}

/**
 * Add a contact.
 *
 * The phone number goes through toE164 before it is stored. This is the single
 * most consequential line in the file: a number saved as typed will never match
 * an inbound call, so the contact looks fine on screen and their calls silently
 * land in the review queue forever.
 */
export async function createContact(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await currentUser();
  if (!user) return { error: "Not signed in." };

  const accountId = String(form.get("accountId") ?? "");
  const firstName = String(form.get("firstName") ?? "").trim();
  const lastName = String(form.get("lastName") ?? "").trim();

  if (!accountId) return { error: "No account given." };
  if (!firstName || !lastName) return { error: "First and last name are both required." };

  const rawPhone = String(form.get("phone") ?? "").trim();
  const phoneE164 = rawPhone ? toE164(rawPhone) : null;

  // Refusing beats storing something the matcher can never use. Telling
  // somebody now is far cheaper than them wondering in three weeks why this
  // contact's calls never appear.
  if (rawPhone && !phoneE164) {
    return {
      fieldErrors: {
        phone:
          "That number cannot be used to match calls. It needs an area code, " +
          "and it cannot be a withheld or partial number.",
      },
    };
  }

  const email = String(form.get("email") ?? "").trim().toLowerCase() || null;

  const [created] = await db
    .insert(schema.contacts)
    .values({
      accountId,
      firstName,
      lastName,
      email,
      phoneE164,
      title: String(form.get("title") ?? "").trim() || null,
    })
    .returning({ id: schema.contacts.id });

  log.info({ contactId: created.id, accountId, by: user.id }, "contact created");

  revalidatePath(`/accounts/${accountId}`);
  return {};
}
