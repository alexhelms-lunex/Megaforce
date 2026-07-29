/**
 * Runtime database client.
 *
 * Two things matter here and both are about serverless:
 *
 *   1. The connection string is the POOLED one (Supavisor, port 6543). Each
 *      serverless invocation opens its own connection; against the direct port
 *      you exhaust Postgres' connection limit under trivial load.
 *   2. `max: 1` plus `prepare: false`. Supavisor in transaction mode hands a
 *      different backend to each statement, so a prepared statement cached on
 *      one backend is not there on the next. Leaving prepare on produces
 *      intermittent "prepared statement does not exist" errors that only appear
 *      under concurrency -- which is to say, only in front of an audience.
 *
 * The client is memoised on globalThis so Next.js hot reload does not leak a
 * new pool on every file save.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __crmSql: ReturnType<typeof postgres> | undefined;
}

function client() {
  if (!globalThis.__crmSql) {
    globalThis.__crmSql = postgres(env.DATABASE_URL, {
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return globalThis.__crmSql;
}

export const db = drizzle(client(), { schema });
export { schema };
