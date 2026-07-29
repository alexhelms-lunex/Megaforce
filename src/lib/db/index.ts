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
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    globalThis.__crmDb = drizzle(globalThis.__crmSql, { schema }) as unknown as Db;
  }
  return globalThis.__crmDb;
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
