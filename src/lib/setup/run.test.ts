import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { checkEnvironment, runSetup, SetupError } from "./run";

/**
 * Exercises the setup routine that both `npm run setup` and GET /api/setup call.
 *
 * A real Postgres sits behind a socket, so migrations and seeding run for
 * real. The one step that cannot be covered here is the Supabase Auth admin
 * call that creates the login -- so the test asserts that when it fails, it
 * fails with an explanation rather than a driver stack trace. That message is
 * the entire product for someone who is stuck.
 */

const PORT = 55433;
const SMALL = { users: 10, accounts: 30, contacts: 90, opportunities: 40, activities: 400, days: 180 };

let pglite: PGlite;
let server: PGLiteSocketServer;
const ORIGINAL = { ...process.env };

beforeAll(async () => {
  pglite = await PGlite.create({ extensions: { uuid_ossp } });
  await pglite.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$ language sql stable;
  `);
  server = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1" });
  await server.start();
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await pglite?.close();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function setEnv(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string> = {
    DIRECT_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  process.env = { ...ORIGINAL, ...base, ...over } as NodeJS.ProcessEnv;
}

describe("the settings check", () => {
  it("names every missing value and where to find it", () => {
    process.env = { ...ORIGINAL };
    for (const key of [
      "DIRECT_URL",
      "DATABASE_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      delete process.env[key];
    }

    try {
      checkEnvironment();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SetupError);
      const e = err as SetupError;
      expect(e.fix).toContain("DIRECT_URL");
      expect(e.fix).toContain("service_role");
      // Not just "this is missing" -- where in the dashboard to go and get it.
      expect(e.fix).toContain("Project Settings");
    }
  });

  it("catches the placeholder password, which is the mistake everyone makes", () => {
    // Both spellings Supabase has used in its dashboard.
    for (const placeholder of ["PASSWORD", "[YOUR-PASSWORD]", "YOUR-PASSWORD"]) {
      setEnv({
        DIRECT_URL: `postgresql://postgres.abc:${placeholder}@db.supabase.com:5432/postgres`,
      });
      try {
        checkEnvironment();
        expect.unreachable(`should have thrown for ${placeholder}`);
      } catch (err) {
        const e = err as SetupError;
        expect(e.problem, placeholder).toContain("placeholder");
        expect(e.fix, placeholder).toContain("Reset database password");
      }
    }
  });

  it("accepts a fully filled-in set", () => {
    setEnv();
    expect(() => checkEnvironment()).not.toThrow();
  });

  it("accepts the new publishable/secret key names as well as the legacy ones", () => {
    setEnv({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc123",
      SUPABASE_SECRET_KEY: "sb_secret_abc123",
    });
    expect(() => checkEnvironment()).not.toThrow();
  });

  it("names both spellings when a key is missing under either", () => {
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEY: undefined });
    try {
      checkEnvironment();
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as SetupError;
      expect(e.fix).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(e.fix).toContain("SUPABASE_SECRET_KEY");
    }
  });
});

describe("passwords that need percent-encoding", () => {
  // Supabase warns about this beside the connection string, in text nobody
  // reads. An unescaped "@" is the worst of them: a URL's password ends at the
  // LAST "@", so it silently redirects the connection to a hostname that does
  // not exist, and the error blames the host rather than the password.
  it("catches an unescaped @ and says how to fix it", () => {
    setEnv({
      DIRECT_URL:
        "postgresql://postgres.abc:my@password@aws-0-us-east-2.pooler.supabase.com:5432/postgres",
    });
    try {
      checkEnvironment();
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as SetupError;
      expect(e.problem).toContain('"@"');
      expect(e.fix).toContain("Reset");
      expect(e.fix).toContain("%40");
    }
  });

  it("catches the other characters that break a connection string", () => {
    for (const [char, pw] of [
      ["/", "pa/ss"],
      ["?", "pa?ss"],
      ["#", "pa#ss"],
      [" ", "pa ss"],
    ] as const) {
      setEnv({
        DIRECT_URL: `postgresql://postgres.abc:${pw}@aws-0.pooler.supabase.com:5432/postgres`,
      });
      expect(() => checkEnvironment(), char).toThrow(/needs escaping/);
    }
  });

  it("leaves ordinary passwords alone", () => {
    // "hunter2password" is here on purpose: an earlier version searched the
    // whole connection string for the substring "password" and rejected any
    // real password that happened to contain the word.
    for (const pw of [
      "simple123",
      "with-dashes-99",
      "UPPER_lower_1234",
      "tilde~and.dots",
      "hunter2password",
    ]) {
      setEnv({
        DIRECT_URL: `postgresql://postgres.abc:${pw}@aws-0.pooler.supabase.com:5432/postgres`,
        DATABASE_URL: `postgresql://postgres.abc:${pw}@aws-0.pooler.supabase.com:6543/postgres`,
      });
      expect(() => checkEnvironment(), pw).not.toThrow();
    }
  });

  it("does not mistake an already-encoded password for a broken one", () => {
    setEnv({
      DIRECT_URL: "postgresql://postgres.abc:my%40password@aws-0.pooler.supabase.com:5432/postgres",
      DATABASE_URL: "postgresql://postgres.abc:my%40password@aws-0.pooler.supabase.com:6543/postgres",
    });
    expect(() => checkEnvironment()).not.toThrow();
  });
});

describe("connection failures", () => {
  it("explains an unreachable host instead of surfacing a driver error", async () => {
    setEnv({ DIRECT_URL: "postgresql://postgres:pw@nope.invalid-host.example:5432/postgres" });
    const result = await runSetup({ volumes: SMALL });

    expect(result.ok).toBe(false);
    expect(result.problem?.problem).toMatch(/could not find the supabase server/i);
    expect(result.problem?.fix).toContain("Project Settings");
    // The step list shows how far it got, so it is obvious what is and is not
    // the cause.
    expect(result.steps.find((s) => s.name.startsWith("Checking"))?.status).toBe("ok");
    expect(result.steps.find((s) => s.name.startsWith("Connecting"))?.status).toBe("failed");
  }, 60_000);
});

describe("the full run against a real database", () => {
  it("migrates and seeds, then fails clearly on the one step needing real Supabase", async () => {
    setEnv();
    const result = await runSetup({ volumes: SMALL, password: "test-password-1234" });

    // Everything up to the Supabase Auth call is genuinely exercised.
    const byName = (n: string) => result.steps.find((s) => s.name.startsWith(n));
    expect(byName("Checking")?.status).toBe("ok");
    expect(byName("Connecting")?.status).toBe("ok");
    expect(byName("Creating tables")?.status).toBe("ok");
    expect(byName("Loading sample data")?.status).toBe("ok");
    expect(byName("Loading sample data")?.detail).toContain("30 companies");

    // The auth admin call cannot succeed against a fake Supabase URL. What
    // matters is that the failure arrives as an explanation.
    expect(result.ok).toBe(false);
    expect(result.problem?.problem).toBeTruthy();
    expect(result.problem?.fix).toBeTruthy();
    // Never a bare driver or fetch error.
    expect(result.problem?.problem).not.toMatch(/ECONNREFUSED|fetch failed|undefined/i);
  }, 180_000);

  it("actually wrote the data, not just reported that it had", async () => {
    const sql = postgres({
      host: "127.0.0.1",
      port: PORT,
      user: "postgres",
      database: "postgres",
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      const [row] = await sql<{ accounts: string; activities: string; admins: string }[]>`
        select
          (select count(*) from accounts)::text   as accounts,
          (select count(*) from activities)::text as activities,
          (select count(*) from users where role = 'admin')::text as admins
      `;
      expect(row.accounts).toBe("30");
      expect(row.activities).toBe("400");
      // The row the login gets linked to has to exist for setup to finish.
      expect(Number(row.admins)).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("is safe to run twice, since people re-run setup when confused", async () => {
    setEnv();
    const again = await runSetup({ volumes: SMALL, password: "test-password-1234" });
    const byName = (n: string) => again.steps.find((s) => s.name.startsWith(n));
    expect(byName("Creating tables")?.status).toBe("ok");
    expect(byName("Loading sample data")?.status).toBe("ok");
  }, 180_000);
});
