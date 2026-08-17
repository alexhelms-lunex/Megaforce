"use server";

import { poolAccounts, type PoolResult } from "@/lib/pool";

export type { PoolAccount, PoolResult } from "@/lib/pool";

/**
 * The dock's read, delegating to the one definition of the pool in
 * src/lib/pool.ts.
 *
 * This file exists only to expose that read to a client component as a server
 * action. Keeping the query itself out of a "use server" module means the full
 * pool screen can import it directly on the server rather than going out and
 * back through an action call it does not need.
 */
export async function fetchPool(query = "", limit = 40): Promise<PoolResult> {
  return poolAccounts({ q: query, limit });
}
