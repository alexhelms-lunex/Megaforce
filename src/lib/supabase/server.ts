import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_CLIENT_KEY, SUPABASE_URL, isSupabaseConfigured } from "./keys";

export { isSupabaseConfigured };

/**
 * The client every user-facing page and action uses.
 *
 * ---------------------------------------------------------------------------
 * WHY THE UI DOES NOT USE DRIZZLE
 *
 * There are two ways into this database, and they are separated on purpose:
 *
 *   Drizzle over a direct Postgres connection -- the seed script, the
 *     migrations, the webhook worker. That connection authenticates as a role
 *     with BYPASSRLS, so row level security does not apply to it. That is
 *     correct for a worker attributing an inbound call to an account it has
 *     never been told about, and catastrophic for anything a user touches.
 *
 *   This client -- carries the signed-in user's JWT on every request, so the
 *     policies in 0002_rls.sql are enforced by Postgres itself.
 *
 * If page queries went through Drizzle, every rep would silently read every
 * account in the company, and no test of the UI would catch it, because the
 * data would look correct. The sharing model has one enforcement point, and
 * this is the client that respects it.
 * ---------------------------------------------------------------------------
 *
 * WHY IT IS WRAPPED IN cache()
 *
 * `cache()` memoises for the life of ONE request. Building the client is cheap;
 * the point is that everything downstream of it -- specifically the auth
 * lookup below -- is then built once per request instead of once per caller.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_CLIENT_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The middleware refreshes the
          // session instead, so this is safe to ignore here.
        }
      },
    },
  });
});

/**
 * Who is signed in, and -- separately -- whether we could find out.
 *
 * ===========================================================================
 * THIS FUNCTION WAS THE CAUSE OF THE "SERVER COMPONENTS RENDER" ERROR.
 *
 * Claim on the pool, Save on the user form and the role picker all failed with
 * the same sentence: "An error occurred in the Server Components render. The
 * specific message is omitted in production builds." All three actions have a
 * complete try/catch and return their failures as data, so none of them could
 * have produced that message from its own body -- which is exactly why reading
 * those three files over and over never found it.
 *
 * The message comes from the RE-RENDER. A server action's response carries the
 * re-rendered route as well as the action's return value, and the route
 * includes the layout. The layout called this function. This function threw.
 * So the action ran, the write landed, and the button reported a failure for
 * something that had already succeeded.
 *
 * TWO THINGS MADE IT THROW, AND BOTH ARE FIXED HERE.
 *
 * 1. supabase-js re-throws network errors out of getUser(). It converts auth
 *    errors into `{ data, error }` -- but a fetch that fails, times out or is
 *    aborted is not an auth error, so it is re-thrown at the caller. Every one
 *    of the thirty-odd callers of this function was an unguarded `await`.
 *
 * 2. It ran a dozen times per request. getUser() is an HTTP call to the auth
 *    server, and this function made two round trips every time it was called --
 *    in the layout, again inside readPreferences(), again in the page, again in
 *    every action. Twelve independent chances for (1) to happen, and twelve
 *    round trips of latency on a screen somebody is waiting for.
 *
 * cache() collapses those to one per request. The retry absorbs a single blip.
 * And the result distinguishes "nobody is signed in" from "we could not ask",
 * because telling somebody to sign in again when the auth server was briefly
 * unreachable sends them to a login screen that will work fine and teaches
 * them the application logs them out at random.
 * ===========================================================================
 */
export interface AuthLookup {
  user: CurrentUser | null;
  /**
   * Set when Supabase could not be reached at all. `user` is null in this case
   * too, but for a completely different reason -- and the difference decides
   * whether somebody is shown a login screen or a "try again" one.
   */
  unreachable?: string;
}

export const loadCurrentUser = cache(async (): Promise<AuthLookup> => {
  if (!isSupabaseConfigured()) return { user: null };

  try {
    const supabase = await createClient();

    // One retry, once. A second attempt costs a few hundred milliseconds and
    // absorbs the single dropped connection that is most of what goes wrong
    // between two clouds; a third would just make a real outage slower to
    // report.
    const { data, error } = await retryOnce(() => supabase.auth.getUser());
    if (error || !data?.user) return { user: null };

    const { data: profile, error: profileError } = await retryOnce(() =>
      supabase
        .from("users")
        .select(
          "id, full_name, email, role, location, start_date, prospect_limit, manager_id, active",
        )
        .eq("auth_id", data.user!.id)
        .maybeSingle(),
    );

    // A failed READ is not the same as an absent row. The first means the
    // database is unreachable or behind; the second means this login has no
    // profile. Reporting the first as the second sends an administrator to the
    // README to fix something that is not broken.
    if (profileError) return { user: null, unreachable: profileError.message };

    return { user: (profile as CurrentUser | null) ?? null };
  } catch (err) {
    return { user: null, unreachable: describe(err) };
  }
});

/**
 * The signed-in user's row from our own users table, or null.
 *
 * Kept as-is for the thirty-odd callers that only need the row. Anything that
 * has to tell "signed out" apart from "could not reach Supabase" -- the layout,
 * and any action whose refusal message says "sign in again" -- should call
 * loadCurrentUser() instead.
 */
export async function currentUser(): Promise<CurrentUser | null> {
  return (await loadCurrentUser()).user;
}

/**
 * The sentence an action should show when there is no user.
 *
 * "Not signed in, reload and sign in again" is correct for a real signed-out
 * state and actively misleading for an unreachable auth server -- the person
 * reloads, is already signed in, presses the button again and gets the same
 * thing.
 */
export function noUserMessage(lookup: AuthLookup): string {
  return lookup.unreachable
    ? `Could not reach the server to check who you are: ${lookup.unreachable}. ` +
        "Nothing was changed. Try again in a moment."
    : "Not signed in. Reload the page and sign in again.";
}

async function retryOnce<T>(run: () => PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return await run();
  }
}

/**
 * Unwrap the real reason behind a thrown error.
 *
 * Node's fetch reports nearly every network problem as the single word "fetch
 * failed" and hides the actual cause one level down in `cause`.
 */
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

export interface CurrentUser {
  id: string;
  /**
   * False once an administrator has deactivated them. The layout refuses the
   * application rather than trusting the login ban alone -- a session issued
   * before the deactivation is still a valid session, and it would otherwise
   * keep working until it expired.
   */
  active?: boolean;
  full_name: string;
  email: string;
  /** 'broker' | 'manager' | 'ad' | 'credit' | 'admin' */
  role: string;
  location: string | null;
  start_date: string | null;
  prospect_limit: number | null;
  manager_id: string | null;
}

/** Roles that see the whole book rather than their own branch of the tree. */
export function isPrivileged(role: string): boolean {
  return role === "admin" || role === "credit";
}
