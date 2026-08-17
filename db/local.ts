/**
 * Local Postgres harness.
 *
 * PGlite is real Postgres compiled to WebAssembly, running in-process. It exists
 * here for one reason: the migrations, the triggers, the row level security
 * policies and the matcher tests all execute for real, against a real query
 * planner, with no credentials and no network. The same .sql files that run here
 * are the ones pasted into Supabase.
 *
 * Two shims are needed to stand in for Supabase, and both are confined to this
 * file so the migrations themselves stay production-clean:
 *
 *   1. `auth.uid()` -- Supabase provides it. Here it reads a session GUC that
 *      `becomeUser()` sets, which is exactly how the real one behaves.
 *   2. A non-superuser role. PGlite connects as a superuser, and superusers
 *      bypass RLS unconditionally. Testing policies as a superuser would pass
 *      while proving nothing, so tests SET ROLE to `app_user` first.
 */
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Walk up from the working directory to find db/migrations.
 *
 * Deliberately not `import.meta.url`: this module is loaded both by vitest (ESM)
 * and by tsx scripts (CommonJS, because the project is not type:module), and
 * import.meta is unavailable in the latter.
 */
function findMigrationsDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate db/migrations walking up from ${process.cwd()}`);
}

const MIGRATIONS_DIR = findMigrationsDir();

/** Stands in for the parts of Supabase the schema depends on. */
const SUPABASE_SHIM = `
  create schema if not exists auth;

  -- Mirrors Supabase's own definition: read the subject claim off the request,
  -- return null when there is no session.
  create or replace function auth.uid() returns uuid as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$ language sql stable;

  -- The role the application connects as. Deliberately not a superuser, so RLS
  -- is actually enforced against it.
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'app_user') then
      create role app_user nologin;
    end if;
  end $$;
`;

/** Granted after the tables exist, since GRANT needs its target present. */
const GRANTS = `
  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public, auth to app_user;
`;

export type LocalDb = PGlite;

export async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATIONS_DIR, name), "utf8"),
    })),
  );
}

/**
 * Boot an empty database and bring it fully up to date.
 *
 * @param dataDir persist to disk at this path; omit for a throwaway in-memory
 *                database, which is what tests want.
 */
export async function createLocalDb(dataDir?: string): Promise<LocalDb> {
  const db = await PGlite.create({
    dataDir,
    extensions: { uuid_ossp, pgcrypto },
  });

  await db.exec(SUPABASE_SHIM);

  for (const { name, sql } of await readMigrations()) {
    try {
      await db.exec(sql);
    } catch (err) {
      // Surfacing which file failed turns "syntax error at or near" into
      // something actionable.
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    }
  }

  await db.exec(GRANTS);
  return db;
}

/**
 * Run the rest of this session as a signed-in user, with RLS enforced.
 *
 * Pass null to sign out. `set_config(..., false)` makes the setting stick for
 * the session rather than the transaction, matching how a pooled request-scoped
 * connection behaves.
 */
export async function becomeUser(db: LocalDb, authId: string | null): Promise<void> {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [authId ?? ""]);
  if (authId) await db.exec("set role app_user;");
}

/** Drop back to superuser: no session, no policies. Used by seeding and jobs. */
export async function becomeService(db: LocalDb): Promise<void> {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [""]);
}
