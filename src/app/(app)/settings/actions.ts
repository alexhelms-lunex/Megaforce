"use server";

import { revalidatePath } from "next/cache";
import { createClient, currentUser } from "@/lib/supabase/server";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";

export interface SaveResult {
  ok?: true;
  error?: string;
}

/**
 * Read the signed-in person's preferences.
 *
 * Falls back to the shipped defaults rather than to nulls, so somebody who has
 * never opened this screen behaves identically to somebody who opened it and
 * changed nothing. Every caller can then treat the result as complete.
 */
export async function readPreferences(): Promise<Preferences> {
  const me = await currentUser();
  if (!me) return DEFAULT_PREFERENCES;

  const supabase = await createClient();
  const { data } = await supabase
    .from("user_preferences")
    .select("*")
    .eq("user_id", me.id)
    .maybeSingle();

  if (!data) return DEFAULT_PREFERENCES;
  return { ...DEFAULT_PREFERENCES, ...(data as Partial<Preferences>) };
}

/**
 * Save a partial change.
 *
 * Upsert rather than update: the row does not exist until somebody changes
 * something, and a settings screen that silently does nothing the first time
 * you use it is a settings screen people stop trusting.
 */
export async function savePreferences(patch: Partial<Preferences>): Promise<SaveResult> {
  const me = await currentUser();
  if (!me) return { error: "Not signed in." };

  const supabase = await createClient();
  const current = await readPreferences();

  const { error } = await supabase.from("user_preferences").upsert(
    {
      ...current,
      ...patch,
      user_id: me.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { error: error.message };

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true };
}

/** Toggle one channel of one alert type. */
export async function saveAlert(
  key: string,
  channel: "app" | "email",
  value: boolean,
): Promise<SaveResult> {
  const current = await readPreferences();
  return savePreferences({
    alerts: {
      ...current.alerts,
      [key]: { ...(current.alerts[key] ?? { app: true, email: true }), [channel]: value },
    },
  });
}
