import "server-only";
import { cache } from "react";
import { createClient, loadCurrentUser } from "@/lib/supabase/server";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";

/**
 * The signed-in person's settings, read once per request.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN settings/actions.ts, WHERE IT USED TO LIVE
 *
 * Two reasons, and the second one is the one that bites.
 *
 * A "use server" module may export ONLY async functions. `export const x =
 * cache(...)` is a const, so putting the memoised version there makes Next
 * reject the entire module at runtime -- every action in it, not just this
 * one. That is the bug that broke every button in this application once
 * already, and boundary.test.ts now fails the build for it.
 *
 * And it needs to be memoised. The layout reads preferences to size the
 * sidebar; the Prospects, Accounts, Available and Contacts screens each read
 * them for the row count. That is five identical round trips to Supabase per
 * page load, on the critical path, for one small row -- on the very screens
 * Alex called slow. React's cache() collapses them into one for the duration
 * of a single render.
 *
 * Memoisation is per REQUEST, not global. Two people loading a page at the
 * same moment get their own lookups; nobody ever sees another person's
 * settings from a shared cache.
 * ---------------------------------------------------------------------------
 */
export const loadPreferences = cache(async (): Promise<Preferences> => {
  /*
   * Never throws.
   *
   * This runs during the layout's render, and a throw there rejects whatever
   * server action the person just pressed -- which is how a working Save
   * button reported a failure for a write that had already succeeded. Falling
   * back to the shipped defaults for one render is invisible by comparison.
   */
  try {
    const { user } = await loadCurrentUser();
    if (!user) return DEFAULT_PREFERENCES;

    const supabase = await createClient();
    const { data } = await supabase
      .from("user_preferences")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!data) return DEFAULT_PREFERENCES;
    // Spread over the defaults rather than used raw: a column added by a
    // migration that has not run yet is simply absent, and every caller can
    // still treat the result as complete.
    return { ...DEFAULT_PREFERENCES, ...(data as Partial<Preferences>) };
  } catch (err) {
    console.error("[settings] could not read preferences", err);
    return DEFAULT_PREFERENCES;
  }
});
