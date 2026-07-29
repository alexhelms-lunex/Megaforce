/**
 * Drizzle bound to the in-process PGlite database.
 *
 * The point is that seed scripts, tests and application queries all compile
 * against one schema and one query builder. Swapping between local Postgres and
 * Supabase is a driver change, not a rewrite.
 */
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/lib/db/schema";
import { createLocalDb, type LocalDb } from "./local";

export type LocalDrizzle = ReturnType<typeof drizzle<typeof schema>>;

export async function createLocalDrizzle(
  dataDir?: string,
): Promise<{ db: LocalDrizzle; pg: LocalDb }> {
  const pg = await createLocalDb(dataDir);
  return { db: drizzle(pg, { schema }), pg };
}

export { schema };
