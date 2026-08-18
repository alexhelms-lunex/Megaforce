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
  /**
   * The browser-safe key. Supabase renamed these: older projects issue `anon`,
   * newer ones `sb_publishable_…`. Either name is accepted.
   */
  get NEXT_PUBLIC_SUPABASE_ANON_KEY() {
    return (
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      required("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    );
  },
  /**
   * Bypasses row level security. Server-only, and only for the webhook worker.
   * If this ever reaches a browser bundle, every row in the database is public.
   * Named `service_role` on older projects, `sb_secret_…` on newer ones.
   */
  get SUPABASE_SERVICE_ROLE_KEY() {
    return process.env.SUPABASE_SECRET_KEY ?? required("SUPABASE_SERVICE_ROLE_KEY");
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
  /**
   * The address the outside world reaches this deployment on.
   *
   * ===========================================================================
   * THIS DEFAULTED TO localhost, AND THAT IS WHY NO CALL EVER LOGGED.
   *
   * RingCentral is told where to deliver calls when the subscription is
   * created. With APP_URL unset -- and nothing anywhere required it to be set --
   * the address handed over was http://localhost:3000/api/webhooks/ringcentral.
   * RingCentral tried it, could not reach it, and refused the subscription with
   *
   *   SUB-521: WebHook is not reachable
   *
   * Everything else looked perfect: five green credentials, a valid token, a
   * production server. One unset variable with a plausible-looking default, and
   * no call could ever arrive.
   *
   * So it is now DERIVED rather than defaulted. Vercel publishes the deployment's
   * own address; asking it is more reliable than asking a person to keep a
   * variable in step with a domain.
   *
   * The order matters:
   *
   *   APP_URL                        an explicit override always wins.
   *   NEXT_PUBLIC_SITE_URL           the same override the reset emails use, so
   *                                    a custom domain is configured once.
   *   VERCEL_PROJECT_PRODUCTION_URL  the STABLE production domain. Preferred
   *                                    over the one below because a subscription
   *                                    lasts seven days and a per-deployment URL
   *                                    stops existing at the next deploy --
   *                                    silently, since RingCentral goes on
   *                                    delivering to an address nobody reads.
   *   VERCEL_URL                     this exact deployment, for previews.
   *
   * Only in development does it fall back to localhost, and ensureSubscription
   * refuses to register an address the outside world cannot reach rather than
   * letting the same failure happen quietly again.
   * ===========================================================================
   */
  get APP_URL() {
    const explicit = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, "");

    const vercel =
      process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
    // Vercel gives the host with no scheme, and it is always https.
    if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

    return "http://localhost:3000";
  },

  /**
   * False when APP_URL is somewhere only this machine can reach.
   *
   * A webhook address is the one setting whose wrongness is invisible: the
   * subscription is refused, or worse accepted and delivered nowhere, and no
   * screen in the application looks any different.
   */
  get appUrlIsPublic() {
    const url = this.APP_URL;
    return /^https:\/\//.test(url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url);
  },

  /** True when RingCentral is fully configured and the real client can run. */
  get ringCentralConfigured() {
    return Boolean(process.env.RC_CLIENT_ID && process.env.RC_CLIENT_SECRET && process.env.RC_JWT);
  },
} as const;

export const isProduction = process.env.NODE_ENV === "production";
