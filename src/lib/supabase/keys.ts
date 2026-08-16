/**
 * Resolves Supabase API keys under either naming scheme.
 *
 * Supabase renamed its keys partway through 2025. Older projects issue a pair
 * of JWTs called `anon` and `service_role`; newer ones issue `sb_publishable_…`
 * and `sb_secret_…`. Both work with supabase-js, they are handed out under
 * different labels in the dashboard, and which one you see depends on when the
 * project was created.
 *
 * Rather than make someone work out which era their project belongs to and
 * rename the value accordingly, both spellings are accepted. Whichever pair the
 * dashboard shows can be pasted under the name printed next to it.
 *
 * The references below are written out literally, and that is not an accident.
 * Next.js inlines NEXT_PUBLIC_* variables into the browser bundle by scanning
 * the source for `process.env.NEXT_PUBLIC_…`. A dynamic lookup like
 * `process.env[name]` is invisible to that scan and arrives in the browser as
 * undefined.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

/** The browser-safe key. Publishable (new) or anon (legacy). */
export const SUPABASE_CLIENT_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

/**
 * The key that bypasses row level security. Secret (new) or service_role
 * (legacy). Server only -- if this ever reaches a browser bundle, every row in
 * the database is readable by anyone. Deliberately a function, so it is never
 * evaluated at module scope in code that might be bundled for the client.
 */
export function supabaseSecretKey(): string {
  return process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
}

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_CLIENT_KEY);
}
