"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient, loadCurrentUser, noUserMessage } from "@/lib/supabase/server";
import { SUPABASE_URL, supabaseSecretKey } from "@/lib/supabase/keys";
import { ROLES, type NewUser, type UserPatch } from "@/lib/roles";

export interface Result {
  ok?: true;
  message?: string;
  error?: string;
  /** Returned when a login was created here, so it can be read out once. */
  password?: string;
}

/**
 * Administering people.
 *
 * ---------------------------------------------------------------------------
 * TWO CLIENTS, AND THE DIFFERENCE MATTERS MORE HERE THAN ANYWHERE ELSE.
 *
 * The ordinary client carries the signed-in user's JWT, so row level security
 * applies. Everything that touches the `users` TABLE goes through it, which
 * means the guard trigger and the admin-only write policy are both enforced by
 * Postgres rather than trusted to this file.
 *
 * The admin client authenticates with the secret key and bypasses everything.
 * It is used for exactly one thing: Supabase's Auth API, which is the only way
 * to create a login, change its email, or set a password. That API has no
 * concept of our roles, so every function here checks the caller is an admin
 * BEFORE reaching for it. A missed check there is not a bug, it is an account
 * takeover.
 *
 * Every action catches its own errors and returns them as sentences. An error
 * that escapes a server action is redacted by Next in production -- the caller
 * gets "the specific message is omitted in production builds", which on a
 * screen full of consequential buttons is useless.
 * ---------------------------------------------------------------------------
 */

/** The Auth API client. Never used to read or write application tables. */
function authAdmin() {
  const key = supabaseSecretKey();
  if (!key) return null;
  return createAdminClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function requireAdmin(): Promise<{ id: string } | { error: string }> {
  // The refusal distinguishes "you are not signed in" from "we could not ask".
  // Both produce no user, and only one of them is fixed by signing in again.
  const lookup = await loadCurrentUser();
  if (!lookup.user) return { error: noUserMessage(lookup) };
  if (lookup.user.role !== "admin") return { error: "Only an administrator can manage users." };
  return { id: lookup.user.id };
}

const WORDS = ["harbor", "cobalt", "ember", "quartz", "meadow", "lantern", "cedar", "ripple"];

/**
 * A password somebody can read down a phone line.
 *
 * Three words and four digits beats a string of symbols for the one job this
 * has: being typed once, by somebody who was told it verbally, before they
 * change it.
 */
export async function generatePassword(): Promise<string> {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function password(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Add somebody.
 *
 * The profile row is written FIRST and the login second. If it went the other
 * way round, a failure at the profile step would leave an orphan login in
 * Supabase that nothing in this application can see or clean up -- and the next
 * attempt with the same address fails with "already registered", which reads
 * like the person already exists when in fact only half of them does.
 *
 * A login is optional. Somebody can exist as a person -- ownable, assignable,
 * countable -- before they have a way in, which is the ordinary state of a
 * starter whose first day is next Monday.
 */
export async function createUser(input: NewUser): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const email = input.email.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { error: "That does not look like an email address." };
    }
    if (!input.full_name.trim()) return { error: "Give them a name." };
    if (!ROLES.some((r) => r.key === input.role)) return { error: "Pick a role." };

    const supabase = await createClient();

    const { data: existing } = await supabase
      .from("users")
      .select("id, full_name")
      .eq("email", email)
      .maybeSingle();
    if (existing) {
      return { error: `${existing.full_name} already has this address.` };
    }

    const { data: created, error } = await supabase
      .from("users")
      .insert({
        email,
        full_name: input.full_name.trim(),
        role: input.role,
        manager_id: input.manager_id || null,
        location: input.location?.trim() || null,
        title: input.title?.trim() || null,
        phone: input.phone?.trim() || null,
        start_date: input.start_date || null,
        prospect_limit: input.prospect_limit ?? null,
        rc_extension_id: input.rc_extension_id?.trim() || null,
      })
      .select("id")
      .single();

    if (error) return { error: friendly(error.message) };

    if (!input.create_login) {
      revalidatePath("/admin/users");
      return { ok: true, message: `${input.full_name} added. No login yet.` };
    }

    const admin = authAdmin();
    if (!admin) {
      return {
        ok: true,
        message:
          `${input.full_name} was added, but no login could be created: the server has no ` +
          `Supabase secret key configured. Add one, then use "Create login" on their row.`,
      };
    }

    const chosen = input.password?.trim() || password();
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      password: chosen,
      email_confirm: true,
    });

    if (authError || !authUser?.user) {
      return {
        ok: true,
        message:
          `${input.full_name} was added, but the login failed: ${authError?.message ?? "unknown error"}. ` +
          `Use "Create login" on their row to try again.`,
      };
    }

    // Link the two. Without this the person signs in successfully and the
    // application cannot work out who they are.
    const { data: linked, error: linkError } = await supabase
      .from("users")
      .update({ auth_id: authUser.user.id })
      .eq("id", created.id)
      .select("id");

    if (linkError) return { error: friendly(linkError.message) };
    if (!linked || linked.length === 0) {
      // The worst version of this failure is the silent one: the login exists
      // and works, and the application cannot tell who signed in, so they land
      // on "no CRM profile for this login" and nobody knows why.
      return {
        error:
          `${input.full_name} was added and a login was created, but the two could not be ` +
          "linked, so they cannot sign in yet. Use \"Create login\" on their row to finish it.",
      };
    }

    revalidatePath("/admin/users");
    return {
      ok: true,
      message: `${input.full_name} added and their login created.`,
      password: chosen,
    };
  } catch (err) {
    return { error: `Could not add them: ${describe(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export async function updateUser(userId: string, patch: UserPatch): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const supabase = await createClient();
    const { data: before } = await supabase
      .from("users")
      .select("email, auth_id, full_name")
      .eq("id", userId)
      .maybeSingle();
    if (!before) return { error: "That person no longer exists." };

    const next: Record<string, unknown> = {};
    if (patch.full_name !== undefined) next.full_name = patch.full_name.trim();
    if (patch.title !== undefined) next.title = patch.title.trim() || null;
    if (patch.phone !== undefined) next.phone = patch.phone.trim() || null;
    if (patch.location !== undefined) next.location = patch.location.trim() || null;
    if (patch.start_date !== undefined) next.start_date = patch.start_date || null;
    if (patch.prospect_limit !== undefined) next.prospect_limit = patch.prospect_limit;
    if (patch.manager_id !== undefined) next.manager_id = patch.manager_id || null;
    if (patch.rc_extension_id !== undefined) {
      next.rc_extension_id = patch.rc_extension_id.trim() || null;
    }
    if (patch.notes !== undefined) next.notes = patch.notes.trim() || null;

    let emailChanged = false;
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return { error: "That does not look like an email address." };
      }
      if (email !== before.email) {
        next.email = email;
        emailChanged = true;
      }
    }

    if (Object.keys(next).length > 0) {
      /*
       * `.select("id")` is not decoration. It is how this finds out whether the
       * write actually landed.
       *
       * An UPDATE that matches no rows is a SUCCESS as far as PostgREST is
       * concerned -- no error, nothing returned. Row level security does not
       * refuse a write, it makes the rows invisible, so a policy that does not
       * admit the caller produces "0 rows updated" and this action cheerfully
       * reported "Saved." The name on screen then reverted on the next refresh,
       * with nothing anywhere saying why. That is the "I tried changing the
       * name and it did not work" with no error message.
       */
      const { data: updated, error } = await supabase
        .from("users")
        .update(next)
        .eq("id", userId)
        .select("id");

      if (error) return { error: friendly(error.message) };
      if (!updated || updated.length === 0) {
        return {
          error:
            "Nothing was saved. The database refused the change for this account — which " +
            "usually means the row level security policies are older than this build. " +
            "Re-run setup from the Admin screen and try again.",
        };
      }
    }

    // The address lives in two places and both have to move, or somebody signs
    // in with an address the application no longer knows them by.
    if (emailChanged && before.auth_id) {
      const admin = authAdmin();
      if (admin) {
        const { error } = await admin.auth.admin.updateUserById(before.auth_id, {
          email: String(next.email),
          email_confirm: true,
        });
        if (error) {
          return {
            ok: true,
            message:
              `Saved, but their SIGN-IN address is still ${before.email}: ${error.message}. ` +
              `They sign in with the old one until this is fixed.`,
          };
        }
      }
    }

    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: "Saved." };
  } catch (err) {
    return { error: `Could not save: ${describe(err)}` };
  }
}

/**
 * Change a role.
 *
 * Goes through admin_set_role() rather than a plain UPDATE, so the last-admin
 * refusal comes back as a sentence instead of a constraint violation.
 */
export async function setRole(userId: string, role: string): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_set_role", { p_user: userId, p_role: role });
    if (error) return { error: friendly(error.message) };

    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: `Role changed to ${role}.` };
  } catch (err) {
    return { error: `Could not change the role: ${describe(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Leaving and coming back
// ---------------------------------------------------------------------------

export async function deactivateUser(
  userId: string,
  disposition: "release" | "transfer" | "keep",
  transferTo?: string,
): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("admin_deactivate_user", {
      p_user: userId,
      p_disposition: disposition,
      p_transfer_to: transferTo || null,
    });
    if (error) return { error: friendly(error.message) };

    // Also stop them signing in. Best effort: the profile is already inactive,
    // and the layout refuses an inactive profile regardless of the login.
    const { data: person } = await supabase
      .from("users")
      .select("auth_id, full_name")
      .eq("id", userId)
      .maybeSingle();
    if (person?.auth_id) {
      const admin = authAdmin();
      // 100 years. Supabase has no permanent ban, and a duration long enough to
      // outlive the company is the same thing in practice.
      await admin?.auth.admin
        .updateUserById(person.auth_id, { ban_duration: "876000h" })
        .catch(() => {});
    }

    const moved = Number(data ?? 0);
    revalidatePath("/admin/users");
    return {
      ok: true,
      message:
        moved > 0
          ? disposition === "transfer"
            ? `Deactivated. ${moved} account${moved === 1 ? "" : "s"} transferred.`
            : `Deactivated. ${moved} account${moved === 1 ? "" : "s"} returned to the available pool.`
          : "Deactivated. They held no accounts.",
    };
  } catch (err) {
    return { error: `Could not deactivate them: ${describe(err)}` };
  }
}

export async function reactivateUser(userId: string): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_reactivate_user", { p_user: userId });
    if (error) return { error: friendly(error.message) };

    const { data: person } = await supabase
      .from("users")
      .select("auth_id")
      .eq("id", userId)
      .maybeSingle();
    if (person?.auth_id) {
      const admin = authAdmin();
      await admin?.auth.admin
        .updateUserById(person.auth_id, { ban_duration: "none" })
        .catch(() => {});
    }

    revalidatePath("/admin/users");
    return { ok: true, message: "Back in. They can sign in again." };
  } catch (err) {
    return { error: `Could not reactivate them: ${describe(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

/** Give somebody who exists as a person a way in. */
export async function createLogin(userId: string): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const supabase = await createClient();
    const { data: person } = await supabase
      .from("users")
      .select("email, full_name, auth_id")
      .eq("id", userId)
      .maybeSingle();
    if (!person) return { error: "That person no longer exists." };
    if (person.auth_id) return { error: `${person.full_name} already has a login.` };

    const admin = authAdmin();
    if (!admin) {
      return { error: "The server has no Supabase secret key configured, so logins cannot be created." };
    }

    const chosen = password();
    const { data: created, error } = await admin.auth.admin.createUser({
      email: person.email,
      password: chosen,
      email_confirm: true,
    });

    // A login may already exist from a half-finished attempt. Adopt it rather
    // than reporting "already registered" at somebody who can see no login.
    let authId = created?.user?.id;
    if (error && /already|registered|exists/i.test(error.message)) {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
      const found = list?.users.find(
        (u) => u.email?.toLowerCase() === person.email.toLowerCase(),
      );
      if (found) {
        await admin.auth.admin.updateUserById(found.id, { password: chosen });
        authId = found.id;
      }
    }

    if (!authId) return { error: `Could not create the login: ${error?.message ?? "unknown error"}` };

    const { data: linked, error: linkError } = await supabase
      .from("users")
      .update({ auth_id: authId })
      .eq("id", userId)
      .select("id");
    if (linkError) return { error: friendly(linkError.message) };
    if (!linked || linked.length === 0) {
      return {
        error:
          "The login was created but could not be attached to their profile, so they still " +
          "cannot sign in. Nothing else was changed — try again.",
      };
    }

    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: `Login created for ${person.full_name}.`, password: chosen };
  } catch (err) {
    return { error: `Could not create the login: ${describe(err)}` };
  }
}

/** Set a new password and show it once. */
export async function resetPassword(userId: string): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };

    const supabase = await createClient();
    const { data: person } = await supabase
      .from("users")
      .select("auth_id, full_name")
      .eq("id", userId)
      .maybeSingle();
    if (!person?.auth_id) return { error: "They have no login to reset." };

    const admin = authAdmin();
    if (!admin) return { error: "The server has no Supabase secret key configured." };

    const chosen = password();
    const { error } = await admin.auth.admin.updateUserById(person.auth_id, { password: chosen });
    if (error) return { error: error.message };

    return {
      ok: true,
      message: `New password for ${person.full_name}. It is shown once — copy it now.`,
      password: chosen,
    };
  } catch (err) {
    return { error: `Could not reset the password: ${describe(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

/**
 * The same operations, over a selection.
 *
 * Applied one at a time and reported as a tally rather than stopping at the
 * first refusal. Changing eight roles and being told only that the fourth was
 * refused, with no way to know whether the other seven went through, is worse
 * than either outcome on its own.
 */
export async function bulkAction(
  userIds: string[],
  action: "role" | "deactivate" | "reactivate",
  value?: string,
): Promise<Result> {
  try {
    const guard = await requireAdmin();
    if ("error" in guard) return { error: guard.error };
    if (userIds.length === 0) return { error: "Nobody is selected." };

    let done = 0;
    const refused: string[] = [];

    for (const id of userIds) {
      const result =
        action === "role"
          ? await setRole(id, value ?? "broker")
          : action === "deactivate"
            ? await deactivateUser(id, (value as "release" | "keep") ?? "release")
            : await reactivateUser(id);

      if (result.error) refused.push(result.error);
      else done += 1;
    }

    revalidatePath("/admin/users");

    if (refused.length === 0) {
      return { ok: true, message: `${done} updated.` };
    }
    return {
      ok: true,
      message: `${done} updated, ${refused.length} refused. First reason: ${refused[0]}`,
    };
  } catch (err) {
    return { error: `Could not apply that: ${describe(err)}` };
  }
}

// ---------------------------------------------------------------------------

function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (e.message && !parts.includes(e.message)) parts.push(e.message);
    current = e.cause;
  }
  return parts.join(" — ") || String(err);
}

function friendly(message: string): string {
  if (/last active administrator/i.test(message)) {
    return "That would leave nobody able to administer the system. Promote somebody else first.";
  }
  if (/already reports to them|own manager/i.test(message)) {
    return message.replace(/^.*?ERROR:\s*/i, "");
  }
  if (/duplicate key.*users_email/i.test(message)) {
    return "Somebody already has that email address.";
  }
  if (/duplicate key.*rc_extension/i.test(message)) {
    return "That RingCentral extension is already assigned to somebody else.";
  }
  if (/does not exist|schema cache|could not find/i.test(message)) {
    return (
      "The database is behind this version of the app. An administrator needs to re-run " +
      `setup to apply the latest migrations. (${message})`
    );
  }
  if (/row-level security|permission denied|insufficient_privilege/i.test(message)) {
    return "You do not have permission to do that.";
  }
  return message.replace(/^.*?ERROR:\s*/i, "");
}
