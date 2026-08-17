"use server";

import { revalidatePath } from "next/cache";
import { createClient, loadCurrentUser, noUserMessage } from "@/lib/supabase/server";
import { type Preferences } from "@/lib/preferences";
import { loadPreferences } from "@/lib/prefs-server";

export interface SaveResult {
  ok?: true;
  error?: string;
}

/**
 * Read the signed-in person's preferences.
 *
 * A thin pass-through to the memoised reader in lib/prefs-server.ts. The
 * implementation cannot live here: a "use server" module may export only async
 * functions, and `export const x = cache(...)` is a const -- which makes Next
 * reject this entire file at runtime, taking every action in it down. See that
 * file for why the memoisation matters.
 */
export async function readPreferences(): Promise<Preferences> {
  return loadPreferences();
}

/**
 * Save a partial change.
 *
 * Upsert rather than update: the row does not exist until somebody changes
 * something, and a settings screen that silently does nothing the first time
 * you use it is a settings screen people stop trusting.
 */
export async function savePreferences(patch: Partial<Preferences>): Promise<SaveResult> {
  try {
    const lookup = await loadCurrentUser();
    if (!lookup.user) return { error: noUserMessage(lookup) };

    const supabase = await createClient();
    const current = await readPreferences();

    const { data: written, error } = await supabase
      .from("user_preferences")
      .upsert(
        {
          ...current,
          ...patch,
          user_id: lookup.user.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      // Read back, so "saved" means saved. An upsert whose UPDATE half matches
      // no rows -- which is what row level security hiding the existing row
      // looks like -- returns success having written nothing, and a settings
      // screen that says Saved and changes nothing is the exact complaint this
      // screen has already produced twice.
      .select("user_id");

    if (error) {
      if (/does not exist|schema cache|could not find/i.test(error.message)) {
        return {
          error:
            "Settings cannot be saved because the database is behind this version of the app. " +
            `An administrator needs to re-run setup. (${error.message})`,
        };
      }
      return { error: error.message };
    }

    if (!written || written.length === 0) {
      return {
        error:
          "Nothing was saved. The database refused the write, which usually means the " +
          "preferences table is older than this build — an administrator should re-run setup.",
      };
    }

    // Guarded for the same reason the claim action guards it: a stale cache
    // entry is one refresh away from being right, and is not a reason to tell
    // somebody their settings did not save when the row has already changed.
    for (const path of ["/settings", "/"]) {
      try {
        revalidatePath(path);
      } catch {
        /* not worth failing a successful save over */
      }
    }
    return { ok: true };
  } catch (err) {
    return { error: `Could not save your settings: ${describe(err)}` };
  }
}

/** Toggle one channel of one alert type. */
export async function saveAlert(
  key: string,
  channel: "app" | "email",
  value: boolean,
): Promise<SaveResult> {
  try {
    const current = await readPreferences();
    return await savePreferences({
      alerts: {
        ...current.alerts,
        [key]: { ...(current.alerts[key] ?? { app: true, email: true }), [channel]: value },
      },
    });
  } catch (err) {
    return { error: `Could not change that alert: ${describe(err)}` };
  }
}

function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (e?.message && !parts.includes(e.message)) parts.push(e.message);
    current = e?.cause;
  }
  return parts.join(" — ") || String(err);
}
