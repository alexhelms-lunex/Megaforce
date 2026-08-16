import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_EMAIL,
  describeError,
  linkByAuthId,
  linkExistingLogin,
  listAuthLogins,
} from "./run";

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
    -- Stands in for the table Supabase Auth maintains. Deliberately minimal:
    -- id and email only, so anything relying on a column beyond those two
    -- fails here rather than on someone's deployment.
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

describe("linking a login whose email is not the seed's placeholder", () => {
  // The first real deployment made a login called alex.helmsworth@megaforce.test
  // because that is a sensible thing to type. Requiring an exact match with a
  // name invented by a seed script would have meant deleting it and starting
  // again for no reason.
  const MINE = "alex.helmsworth@megaforce.test";

  it("attaches any address to the admin profile, and adopts it", async () => {
    await sql`delete from auth.users`;
    await sql`delete from users`;
    await sql`
      insert into users (email, full_name, role)
      values (${ADMIN_EMAIL}, 'Avery Stone', 'admin')
    `;
    const [mine] = await sql<{ id: string }[]>`
      insert into auth.users (email) values (${MINE}) returning id
    `;

    expect(await linkExistingLogin(sql, MINE)).toBe(true);

    const [profile] = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users where role = 'admin'
    `;
    expect(profile.auth_id).toBe(mine.id);
    // The address used in the dashboard becomes the CRM's address, rather than
    // leaving the app displaying a name the user never chose.
    expect(profile.email).toBe(MINE);
  });

  it("moves the link cleanly when a different login is chosen afterwards", async () => {
    // auth_id is unique, so re-linking has to clear the old pointer first or
    // the update collides.
    const OTHER = "someone.else@megaforce.test";
    const [other] = await sql<{ id: string }[]>`
      insert into auth.users (email) values (${OTHER}) returning id
    `;

    expect(await linkExistingLogin(sql, OTHER)).toBe(true);

    const [profile] = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users where role = 'admin'
    `;
    expect(profile.auth_id).toBe(other.id);
    expect(profile.email).toBe(OTHER);
  });

  it("lists the logins that do exist, so a miss is a fix and not a puzzle", async () => {
    const logins = await listAuthLogins(sql);
    expect(logins.map((l) => l.email)).toEqual(
      expect.arrayContaining([MINE, "someone.else@megaforce.test"]),
    );
  });

  it("still reports false for an address nobody made", async () => {
    expect(await linkExistingLogin(sql, "nobody@megaforce.test")).toBe(false);
  });
});

describe("linking by the ID pasted from the dashboard", () => {
  // The path that cannot be refused. Supabase keeps auth.users under a schema
  // owned by its own role, and a project may not grant the app's role read
  // access -- so listing the logins can fail while the login plainly exists.
  // Writing our OWN users table never needs anyone's permission.
  const UID = "52a67572-7bce-405d-93a3-77b8601ffc8d";

  beforeAll(async () => {
    await sql`delete from auth.users`;
    await sql`delete from users`;
    await sql`
      insert into users (email, full_name, role)
      values (${ADMIN_EMAIL}, 'Avery Stone', 'admin')
    `;
  });

  it("links without ever reading the auth schema", async () => {
    await linkByAuthId(sql, UID, "alex.helmsworth@megaforce.test");

    const [profile] = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users where role = 'admin'
    `;
    expect(profile.auth_id).toBe(UID);
    expect(profile.email).toBe("alex.helmsworth@megaforce.test");
  });

  it("tolerates surrounding whitespace from a copy and paste", async () => {
    await expect(linkByAuthId(sql, `  ${UID}\n`)).resolves.toBeUndefined();
  });

  it("leaves the email alone when none is supplied", async () => {
    const [before] = await sql<{ email: string }[]>`
      select email from users where role = 'admin'
    `;
    await linkByAuthId(sql, UID);
    const [after] = await sql<{ email: string }[]>`
      select email from users where role = 'admin'
    `;
    expect(after.email).toBe(before.email);
  });

  it("rejects something that is not an ID, and shows where to find one", async () => {
    for (const bad of ["", "not-a-uuid", "alex.helmsworth@megaforce.test", "1234"]) {
      await expect(linkByAuthId(sql, bad), bad).rejects.toThrow(/does not look like a user ID/);
    }
    // The guidance points at the column in the dashboard, not at a spec. It
    // lives on `fix`, which is what the page renders beneath the headline.
    await linkByAuthId(sql, "nope").then(
      () => expect.unreachable("should have thrown"),
      (err) => {
        expect(err.fix).toContain("Authentication → Users");
        expect(err.fix).toContain("UID");
      },
    );
  });

  it("is safe to run twice with the same ID", async () => {
    await linkByAuthId(sql, UID);
    await expect(linkByAuthId(sql, UID)).resolves.toBeUndefined();
  });
});

describe("reseeding does not lock you out", () => {
  /**
   * The failure this guards against, seen on a real deployment: the seed
   * rebuilds every user row, which severs the connection between a Supabase
   * login and its CRM profile. Someone who reseeds to pick up new sample data
   * is then locked out of the app they just reloaded, with nothing to suggest
   * the two events are related.
   *
   * runSetup captures the link before seeding and restores it afterwards. This
   * covers the restore half directly -- the part that has to survive the users
   * table being emptied underneath it.
   */
  const UID = "52a67572-7bce-405d-93a3-77b8601ffc8d";
  const EMAIL = "alex.helmsworth@megaforce.test";

  it("reattaches a remembered login to the rebuilt admin profile", async () => {
    await sql`delete from users`;
    await sql`
      insert into users (email, full_name, role, auth_id)
      values (${EMAIL}, 'Alex Helmsworth', 'admin', ${UID}::uuid)
    `;

    // What the seed does: wipe every user, then build a fresh set.
    const remembered = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users where auth_id is not null and role = 'admin' limit 1
    `;
    expect(remembered).toHaveLength(1);

    await sql`delete from users`;
    await sql`
      insert into users (email, full_name, role)
      values (${ADMIN_EMAIL}, 'Avery Stone', 'admin')
    `;

    // The profile now exists again but points at nobody -- the locked-out state.
    const [orphaned] = await sql<{ auth_id: string | null }[]>`
      select auth_id from users where role = 'admin'
    `;
    expect(orphaned.auth_id).toBeNull();

    await linkByAuthId(sql, remembered[0].auth_id, remembered[0].email);

    const [restored] = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users where role = 'admin'
    `;
    expect(restored.auth_id).toBe(UID);
    // The address survives too, so the app keeps showing the name they chose.
    expect(restored.email).toBe(EMAIL);
  });

  it("prefers the admin's link over the credit team's", async () => {
    await sql`delete from users`;
    await sql`
      insert into users (email, full_name, role, auth_id) values
        ('credit@megaforce.test', 'Credit Desk', 'credit', '11111111-1111-1111-1111-111111111111'::uuid),
        (${EMAIL}, 'Alex Helmsworth', 'admin', ${UID}::uuid)
    `;

    const [remembered] = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users
       where auth_id is not null and role in ('admin','credit')
       order by case role when 'admin' then 0 else 1 end
       limit 1
    `;
    expect(remembered.auth_id).toBe(UID);
  });
});
