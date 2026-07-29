import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
            // Server Components cannot set cookies. The middleware refreshes
            // the session instead, so this is safe to ignore here.
          }
        },
      },
    },
  );
}

/** True when Supabase credentials are present. Drives the setup screen. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** The signed-in user's row from our own users table, or null. */
export async function currentUser() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("id, full_name, email, role")
    .eq("auth_id", user.id)
    .maybeSingle();

  return data as { id: string; full_name: string; email: string; role: string } | null;
}
