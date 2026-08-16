import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_CLIENT_KEY, SUPABASE_URL } from "./keys";

/** Browser-side client. Publishable/anon key only -- never the secret one. */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_CLIENT_KEY);
}
