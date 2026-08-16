import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ADMIN_EMAIL, describeError, linkExistingLogin } from "./run";

/**
 * The rescue path.
 *
 * Supabase's login service lives on a different host from the database, so it
 * can be unreachable while migrations and seeding have already succeeded --
 * which is exactly what happened on the first real deployment. Recovering from
 * that must not require re-running anything.
 *
 * The insight this leans on: Supabase keeps its logins in an `auth.users` table
 * inside the same database. So a login created by hand in the dashboard can be
 * attached over the connection that has already proven it works, with no HTTP
 * call to the Auth API at all.
 */

const PORT = 55434;

let pglite: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql;

beforeAll(async () => {
  pglite = await PGlite.create({ extensions: { uuid_ossp } });
  await pglite.exec(`
    -- The migrations create this too, but the fixture table below needs it
    -- first, and this runs before they do.
    create extension if not exists "uuid-ossp";
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$ language sql stable;
    -- Stands in for the table Supabase Auth maintains.
    create table if not exists auth.users (
      id uuid primary key default uuid_generate_v4(),
      email text unique
    );
  `);

  server = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1" });
  await server.start();

  sql = postgres({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    database: "postgres",
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  const dir = path.join(process.cwd(), "db", "migrations");
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(await readFile(path.join(dir, file), "utf8")).simple();
  }
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await server?.stop();
  await pglite?.close();
});

describe("linking a login that already exists", () => {
  it("reports honestly when there is no Supabase login yet", async () => {
    await sql`delete from auth.users`;
    await sql`delete from users`;
    await sql`
      insert into users (email, full_name, role)
      values (${ADMIN_EMAIL}, 'Avery Stone', 'admin')
    `;

    expect(await linkExistingLogin(sql)).toBe(false);
  });

  it("attaches a login created by hand in the dashboard", async () => {
    const [authUser] = await sql<{ id: string }[]>`
      insert into auth.users (email) values (${ADMIN_EMAIL}) returning id
    `;

    expect(await linkExistingLogin(sql)).toBe(true);

    const [crmUser] = await sql<{ auth_id: string }[]>`
      select auth_id from users where email = ${ADMIN_EMAIL}
    `;
    expect(crmUser.auth_id).toBe(authUser.id);
  });

  it("ignores the case of the address, as Supabase does", async () => {
    await sql`delete from auth.users`;
    await sql`update users set auth_id = null where email = ${ADMIN_EMAIL}`;
    const [authUser] = await sql<{ id: string }[]>`
      insert into auth.users (email) values ('Avery.Stone@Megaforce.TEST') returning id
    `;

    expect(await linkExistingLogin(sql)).toBe(true);
    const [crmUser] = await sql<{ auth_id: string }[]>`
      select auth_id from users where email = ${ADMIN_EMAIL}
    `;
    expect(crmUser.auth_id).toBe(authUser.id);
  });

  it("is safe to run twice", async () => {
    expect(await linkExistingLogin(sql)).toBe(true);
    expect(await linkExistingLogin(sql)).toBe(true);
  });
});

describe("describeError", () => {
  // Node's fetch reports nearly every network failure as the two words "fetch
  // failed" and hides the real reason one level down in `cause`. Reporting only
  // the top-level message describes every possible failure equally, and so
  // points at none of them.
  it("unwraps the cause hidden beneath a bare fetch failure", () => {
    const inner = Object.assign(new Error("getaddrinfo ENOTFOUND nope.supabase.co"), {
      code: "ENOTFOUND",
    });
    const outer = Object.assign(new TypeError("fetch failed"), { cause: inner });

    const described = describeError(outer);
    expect(described).toContain("fetch failed");
    expect(described).toContain("ENOTFOUND");
    expect(described).toContain("nope.supabase.co");
  });

  it("handles an error with no cause", () => {
    expect(describeError(new Error("plain failure"))).toBe("plain failure");
  });

  it("does not loop forever on a self-referencing cause", () => {
    const err: Error & { cause?: unknown } = new Error("recursive");
    err.cause = err;
    expect(describeError(err)).toBe("recursive");
  });

  it("survives being handed something that is not an error", () => {
    expect(describeError("just a string")).toBe("just a string");
  });
});
