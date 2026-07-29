/**
 * One difference between the two drivers, normalised in one place.
 *
 * `db.execute(sql\`...\`)` returns a bare array under postgres-js and a
 * `{ rows, fields, affectedRows }` object under PGlite. Code that assumes
 * either shape works perfectly in tests and fails in production, or the
 * reverse. Everything that runs raw SQL goes through here instead.
 *
 * Drizzle's query builder already normalises this; only raw execute needs it,
 * which in practice means aggregate queries with GROUP BY / HAVING.
 */
export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** First row, or undefined. */
export function firstRow<T>(result: unknown): T | undefined {
  return rows<T>(result)[0];
}
