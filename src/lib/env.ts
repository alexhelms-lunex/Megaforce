/**
 * Environment access.
 *
 * Every read goes through here so a missing variable fails with a sentence you
 * can act on, at the moment it is needed -- rather than as `undefined` three
 * layers deeper in a connection string.
 *
 * Validation is lazy on purpose. `next build` runs with no secrets present, and
 * a module-level throw would break the build rather than the request.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  /** Supavisor pooled connection, port 6543. What the running app uses. */
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  /** Direct connection, port 5432. Migrations only -- never request traffic. */
  get DIRECT_URL() {
    return required("DIRECT_URL");
  },
  get NEXT_PUBLIC_SUPABASE_URL() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get NEXT_PUBLIC_SUPABASE_ANON_KEY() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  /**
   * Bypasses row level security. Server-only, and only for the webhook worker.
   * If this ever reaches a browser bundle, every row in the database is public.
   */
  get SUPABASE_SERVICE_ROLE_KEY() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },

  // RingCentral. Absent until a sandbox app exists; the simulator does not need
  // them, so these are optional and the caller checks.
  get RC_SERVER() {
    return optional("RC_SERVER", "https://platform.devtest.ringcentral.com");
  },
  get RC_CLIENT_ID() {
    return optional("RC_CLIENT_ID");
  },
  get RC_CLIENT_SECRET() {
    return optional("RC_CLIENT_SECRET");
  },
  get RC_JWT() {
    return optional("RC_JWT");
  },
  get RC_WEBHOOK_SECRET() {
    return optional("RC_WEBHOOK_SECRET");
  },
  get APP_URL() {
    return optional("APP_URL", "http://localhost:3000");
  },

  /** True when RingCentral is fully configured and the real client can run. */
  get ringCentralConfigured() {
    return Boolean(process.env.RC_CLIENT_ID && process.env.RC_CLIENT_SECRET && process.env.RC_JWT);
  },
} as const;

export const isProduction = process.env.NODE_ENV === "production";
