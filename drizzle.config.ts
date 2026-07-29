import "dotenv/config";
import type { Config } from "drizzle-kit";

/**
 * Migrations run against the DIRECT connection (port 5432), never the pooler.
 * DDL in a transaction-mode pooler is a good way to get a half-applied schema.
 *
 * Note that db/migrations/*.sql is hand-written and is the source of truth.
 * drizzle-kit is used here for `generate`/`check` to catch drift between those
 * files and src/lib/db/schema.ts -- not to author migrations.
 */
export default {
  schema: "./src/lib/db/schema.ts",
  out: "./db/drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DIRECT_URL ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;
