/**
 * Runtime database client, for server-side and worker code.
 *
 * NOT for user-facing reads. This connection authenticates as a role that
 * bypasses row level security, which is correct for the webhook worker (it has
 * to attribute a call to an account nobody has told it about) and wrong for
 * anything a signed-in user touches. Pages and user actions go through
 * src/lib/supabase/server.ts instead, which carries the user's JWT so the
 * policies apply.
 *
 * Two connection details matter, and both are about serverless:
 *
 *   1. The POOLED connection string (Supavisor, port 6543). Each invocation
 *      opens its own connection; against the direct port you exhaust Postgres'
 *      connection limit under trivial load.
 *
 *   2. `max: 1` with `prepare: false`. Supavisor in transaction mode hands a
 *      different backend to each statement, so a prepared statement cached on
 *      one backend is absent on the next. Leaving prepare on produces
 *      intermittent "prepared statement does not exist" errors that surface
 *      only under concurrency -- which is to say, only in front of an audience.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import type { Db } from "@/lib/matcher";
import * as schema from "./schema";

declare global {
  var __crmSql: ReturnType<typeof postgres> | undefined;
  var __crmDb: Db | undefined;
}

/**
 * Build the client on first use, not at import.
 *
 * `next build` runs with no secrets present and imports every route module to
 * collect page data. Connecting at module scope makes the build fail on a
 * missing DATABASE_URL, which is a deployment-time value, not a build-time one.
 * Memoised on globalThis so hot reload does not leak a pool per file save.
 */
export function getDb(): Db {
  if (!globalThis.__crmDb) {
    globalThis.__crmSql ??= postgres(env.DATABASE_URL, {
      /*
       * Three, not one.
       *
       * `max: 1` was chosen so a hundred serverless instances could not exhaust
       * Postgres' connection limit, and against Supavisor that caution was
       * already being applied on our behalf. What it actually bought was a
       * single point of wedging: postgres.js queues queries behind the one
       * connection, and a query that never returns blocks every later query on
       * that instance FOREVER -- including the ones that would have rendered a
       * page saying something was wrong.
       *
       * Three is still modest per instance and means one stuck query is a slow
       * screen rather than a dead deployment.
       */
      max: 3,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
      /*
       * Recycle connections rather than trusting them indefinitely. A pooled
       * connection that has been silently dropped in the middle -- an idle
       * timeout at the pooler, a failover, a network path that went away --
       * looks perfectly healthy from this side and answers no query ever again.
       */
      max_lifetime: 60 * 30,
    });
    globalThis.__crmDb = drizzle(globalThis.__crmSql, { schema }) as unknown as Db;
  }
  return globalThis.__crmDb;
}

/**
 * A query that is allowed to fail, but not allowed to hang.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT PARANOIA
 *
 * The Phone connection screen rendered a loading skeleton and never anything
 * else. Not a crash -- there are error boundaries and they never fired -- and
 * not the RingCentral timeouts either, which were the first suspicion and were
 * genuinely missing but were not this.
 *
 * It was the DATABASE. Every other screen in the application reads through
 * Supabase's HTTP API, which fails fast and visibly. Exactly one page reads the
 * direct Postgres connection while it renders, and the phone dock -- on every
 * screen -- reads it too. Both hung; everything else was fine. That is the
 * whole diagnosis, and it is only visible if you notice which of the two
 * database clients each screen uses.
 *
 * postgres.js waits forever for an answer. connect_timeout covers only getting
 * a connection in the first place; once connected, a query that is never
 * answered is a promise that never settles, and a server component awaiting it
 * is a page that never renders. No error, no boundary, no way to tell it apart
 * from a slow network.
 *
 * So anything a person is waiting on gets a deadline. The failure then arrives
 * as a sentence on a screen naming the database, which is a thing somebody can
 * act on, instead of a skeleton that means nothing.
 * ===========================================================================
 */
export async function withDeadline<T>(
  work: Promise<T>,
  { ms = 8_000, label = "the database" }: { ms?: number; label?: string } = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} did not answer within ${ms / 1000}s. The deployment may not be able ` +
                  "to reach Postgres directly — check DATABASE_URL.",
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    // The losing promise keeps running either way; this only stops the timer
    // from holding the event loop open after a fast answer.
    if (timer) clearTimeout(timer);
  }
}

/**
 * `db.select()...` reads naturally at call sites, and the proxy keeps that
 * shape while deferring the connection to the first property access. Methods
 * are bound to the real instance so Drizzle's internal `this` still resolves.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };

/**
 * The privileged connection, or null if it is not configured.
 *
 * ---------------------------------------------------------------------------
 * `getDb()` throws when DATABASE_URL is absent, and that is right for a worker:
 * a webhook with no database should fail loudly and be retried.
 *
 * It is wrong for anything a person is looking at. Three user-facing actions
 * need this connection -- logging a call, resolving a queued one, and reading
 * the dock's recent calls -- and the dock is on EVERY screen. A throw there did
 * not produce a message; it took down whatever page the person was on, with the
 * cause redacted by production.
 *
 * So those callers ask for the connection rather than assuming it, and say
 * something useful when the answer is no.
 * ---------------------------------------------------------------------------
 */
export function tryGetDb(): Db | null {
  if (!process.env.DATABASE_URL) return null;
  try {
    return getDb();
  } catch {
    return null;
  }
}

/** The sentence to show when it is missing. Written once so it reads the same everywhere. */
export const DB_UNCONFIGURED =
  "The server cannot reach the database directly, which this action needs. An administrator " +
  "should check that DATABASE_URL is set in the deployment settings.";
