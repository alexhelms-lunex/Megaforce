import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as schema from "../src/lib/db/schema";
import { seed } from "./seed";
import type { Db } from "../src/lib/matcher";

/**
 * Exercises `npm run setup` over a real Postgres wire connection.
 *
 * The other suites drive PGlite in-process, which validates the SQL but skips
 * the driver entirely. This one puts PGlite behind a socket speaking the actual
 * Postgres protocol and connects postgres.js to it -- the same client, the same
 * `sql.unsafe(...).simple()` call, the same Drizzle driver that will run against
 * Supabase.
 *
 * That gap is worth closing because the two paths fail differently. Multi-
 * statement files and dollar-quoted function bodies are a protocol concern, not
 * a SQL one: they work perfectly through PGlite's direct API and fail through a
 * client that defaults to the extended query protocol. Setup breaking on a
 * user's first run is the worst possible place to discover that.
 */

const PORT = 55432;
const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

let pglite: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql;

beforeAll(async () => {
  pglite = await PGlite.create({ extensions: { uuid_ossp } });

  // Supabase provides auth.uid(). Stand it up before the migrations run, since
  // the RLS policies reference it.
  await pglite.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$ language sql stable;
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
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await server?.stop();
  await pglite?.close();
});

describe("migrations over the wire", () => {
  it("applies every file through postgres.js in one round trip each", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      // The exact call scripts/setup.ts makes. .simple() selects the simple
      // query protocol, which is what permits many statements -- and $$ quoted
      // plpgsql bodies -- in a single send.
      await expect(sql.unsafe(contents).simple(), file).resolves.toBeDefined();
    }

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'public' order by 1
    `;
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining([
        "accounts",
        "activities",
        "contacts",
        "field_defs",
        "opportunities",
        "qualification_rules",
        "raw_events",
        "unmatched_activities",
        "users",
      ]),
    );
  });

  it("is safe to run a second time, as setup re-runs are", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await expect(sql.unsafe(contents).simple(), `re-run ${file}`).resolves.toBeDefined();
    }
  });

  it("creates the plpgsql triggers, not just the tables", async () => {
    // Dollar-quoted function bodies are exactly what a naive multi-statement
    // splitter mangles: it would break them at the semicolons inside the body.
    const fns = await sql<{ proname: string }[]>`
      select proname from pg_proc
       where proname in ('bump_last_activity', 'enforce_owner_reassignment', 'visible_user_ids')
       order by 1
    `;
    expect(fns.map((f) => f.proname)).toEqual([
      "bump_last_activity",
      "enforce_owner_reassignment",
      "visible_user_ids",
    ]);
  });

  it("loads the default qualification rules", async () => {
    const rules = await sql<{ activity_type: string; min_duration_seconds: number }[]>`
      select activity_type, min_duration_seconds from qualification_rules
       where activity_type = 'call' and active
    `;
    // 60 seconds, per the prospecting policy. An earlier build shipped 120,
    // which rejected every call between 60 and 119 -- a broker who did the work
    // lost the account anyway.
    expect(rules[0]?.min_duration_seconds).toBe(60);
  });
});

describe("seeding over the wire", () => {
  it("loads a dataset through the postgres-js Drizzle driver", async () => {
    const db = drizzle(sql, { schema }) as unknown as Db;

    const report = await seed(db, {
      users: 10,
      accounts: 40,
      contacts: 120,
      opportunities: 60,
      activities: 600,
      days: 180,
    });

    expect(report.accounts).toBe(40);
    expect(report.qualifyingActivities).toBeGreaterThan(0);

    const counts = await sql<{ accounts: string; activities: string }[]>`
      select
        (select count(*) from accounts)::text   as accounts,
        (select count(*) from activities)::text as activities
    `;
    expect(counts[0].accounts).toBe("40");
    expect(counts[0].activities).toBe("600");
  }, 120_000);

  it("recomputed last_activity_at, so the account list has something to sort by", async () => {
    const [row] = await sql<{ c: string }[]>`
      select count(*)::text c from accounts where last_activity_at is not null
    `;
    expect(Number(row.c)).toBeGreaterThan(0);
  });

  it("planted the ambiguous number the review queue demo depends on", async () => {
    const shared = await sql<{ phone_e164: string }[]>`
      select phone_e164 from contacts
       where phone_e164 is not null
       group by phone_e164
      having count(distinct account_id) > 1
       limit 1
    `;
    expect(shared.length).toBe(1);
  });

  it("left the admin row that setup links the login to", async () => {
    const [admin] = await sql<{ email: string; role: string }[]>`
      select email, role from users where email = 'avery.stone@megaforce.test'
    `;
    expect(admin?.role).toBe("admin");
  });
});
