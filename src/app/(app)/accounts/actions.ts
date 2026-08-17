"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { mergeCustom, parseCustomFields, type FieldDefinition } from "@/lib/custom-values";
import { toE164 } from "@/lib/phone";
import { createClient, currentUser } from "@/lib/supabase/server";

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

/**
 * The live definitions. Read every time, because they are data and can change.
 *
 * ---------------------------------------------------------------------------
 * THROUGH THE USER'S CLIENT, NOT THE SERVICE-ROLE CONNECTION.
 *
 * This whole file used the Drizzle connection, which authenticates with
 * DATABASE_URL and bypasses row level security. Two things were wrong with
 * that, and the first one bit:
 *
 *   1. It is a SECOND way into the database. Every page in this application
 *      reads through the Supabase client, so a missing or wrong DATABASE_URL
 *      let every screen render perfectly and made creating an account, editing
 *      one, and adding a contact fail — with a raw "Missing required
 *      environment variable" rather than anything a user could act on. That is
 *      the same fault that once broke claim and release.
 *
 *   2. Bypassing row level security here bought nothing. Creating a company is
 *      an ordinary user action on rows the policies already permit; the checks
 *      were then re-implemented by hand below, which is strictly worse than
 *      letting Postgres do them.
 * ---------------------------------------------------------------------------
 */
async function accountFieldDefs(): Promise<FieldDefinition[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("field_defs")
    .select("key, label, type, options, required")
    .eq("object", "account")
    .eq("archived", false)
    .order("sort");

  return ((data ?? []) as FieldDefinition[]).map((r) => ({
    ...r,
    type: r.type as FieldDefinition["type"],
  }));
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

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("accounts")
    .insert({
      name,
      status,
      industry: String(form.get("industry") ?? "").trim() || null,
      domain: String(form.get("domain") ?? "").trim() || null,
      owner_id: claim ? user.id : null,
      custom: values,
    })
    .select("id")
    .single();

  if (error || !created) return { error: friendly(error?.message ?? "Could not create the company.") };

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

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("accounts")
    .select("owner_id, custom")
    .eq("id", accountId)
    .maybeSingle();

  if (!existing) return { error: "That account no longer exists, or you cannot see it." };

  // Unowned accounts are editable by anyone -- they are in the pool, and
  // tidying one up before claiming it is reasonable. An owned account belongs
  // to its broker, their management chain, and the privileged roles.
  const privileged = user.role === "admin" || user.role === "credit" || user.role === "manager";
  if (existing.owner_id && existing.owner_id !== user.id && !privileged) {
    return { error: "That account belongs to another broker." };
  }

  const defs = await accountFieldDefs();
  const { values, errors } = parseCustomFields(form, defs);
  if (errors.length > 0) {
    return { fieldErrors: Object.fromEntries(errors.map((e) => [e.key, e.message])) };
  }

  const { data: saved, error: updateError } = await supabase
    .from("accounts")
    .update({
      name,
      status,
      industry: String(form.get("industry") ?? "").trim() || null,
      domain: String(form.get("domain") ?? "").trim() || null,
      // Merged, not replaced: values belonging to retired fields would
      // otherwise be destroyed by an unrelated edit.
      custom: mergeCustom(existing.custom as Record<string, unknown>, values),
    })
    .eq("id", accountId)
    /*
     * `.select("id")` is what makes a refusal visible.
     *
     * Row level security does not reject a write -- it makes the rows
     * invisible, so a policy that does not admit the caller produces an UPDATE
     * matching zero rows, which PostgREST reports as a success with nothing
     * returned. This then redirected to the account page, which rendered the
     * OLD values, with no error anywhere. That is "I changed the status and it
     * did not work", and it is indistinguishable from a save that worked
     * followed by a page that did not refresh.
     */
    .select("id");

  if (updateError) return { error: friendly(updateError.message) };
  if (!saved || saved.length === 0) {
    return {
      error:
        "Nothing was saved — the database refused the change. This usually means the account " +
        "moved to another broker while this form was open. Reload the page and check who holds " +
        "it before trying again.",
    };
  }

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

  const supabase = await createClient();
  const { data: created, error: contactError } = await supabase
    .from("contacts")
    .insert({
      account_id: accountId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone_e164: phoneE164,
      title: String(form.get("title") ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (contactError || !created) {
    return { error: friendly(contactError?.message ?? "Could not add the contact.") };
  }

  log.info({ contactId: created.id, accountId, by: user.id }, "contact created");

  revalidatePath(`/accounts/${accountId}`);
  return {};
}

/**
 * Postgres speaks to developers. These screens speak to brokers.
 *
 * The duplicate guard is the message people will actually meet, and it is not a
 * failure — the account was created, it is simply Credit's now until they
 * decide which record is real.
 */
function friendly(message: string): string {
  if (/duplicate|already exists/i.test(message) && /account|company/i.test(message)) {
    return (
      "That company matches one already on file, so it has been flagged to Credit. " +
      "They decide which record is the real one."
    );
  }
  if (/row-level security|permission denied/i.test(message)) {
    return "You do not have permission to do that.";
  }
  if (/does not exist|schema cache|could not find/i.test(message)) {
    return (
      "The database is behind this version of the app. An administrator needs to re-run " +
      `setup to apply the latest migrations. (${message})`
    );
  }
  return message.replace(/^.*?ERROR:\s*/i, "");
}
