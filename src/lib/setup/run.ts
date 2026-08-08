/**
 * The setup routine, in one place.
 *
 * Two front doors call this: `npm run setup` from a terminal, and a one-time
 * GET /api/setup for people who would rather not open one. Both do exactly the
 * same work, so there is no "the browser version is different" caveat to
 * remember, and no second implementation to keep in step.
 *
 * Nothing here prints. It returns a structured result and lets the caller
 * decide whether that becomes terminal output or an HTML page.
 */
import { createClient } from "@supabase/supabase-js";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { DEFAULT_VOLUMES, seed, type SeedVolumes } from "../../../db/seed";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/matcher";

export const ADMIN_EMAIL = "avery.stone@megaforce.test";

/**
 * A failure the user can act on, paired with what to do about it.
 *
 * Every error this module raises is one of these. A raw driver message like
 * "password authentication failed for user" tells someone who has never seen a
 * connection string precisely nothing.
 */
export class SetupError extends Error {
  constructor(
    readonly problem: string,
    readonly fix: string,
  ) {
    super(problem);
    this.name = "SetupError";
  }
}

export interface SetupStep {
  name: string;
  status: "ok" | "failed";
  detail: string;
}

export interface SetupResult {
  ok: boolean;
  steps: SetupStep[];
  login?: { email: string; password: string };
  stats?: {
    accounts: number;
    contacts: number;
    activities: number;
    qualifyingRate: string;
  };
  landmarks?: Record<string, string>;
  problem?: { problem: string; fix: string };
}

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

const REQUIRED: { key: string; where: string }[] = [
  {
    key: "DIRECT_URL",
    where: "Supabase → Project Settings → Database → Connection string → URI, the one on port 5432",
  },
  { key: "DATABASE_URL", where: "same screen, the one on port 6543" },
  { key: "NEXT_PUBLIC_SUPABASE_URL", where: "Supabase → Project Settings → API → Project URL" },
  {
    key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    where: "Supabase → Project Settings → API → anon public",
  },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    where: "Supabase → Project Settings → API → service_role",
  },
];

export function checkEnvironment(): void {
  const missing = REQUIRED.filter(({ key }) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new SetupError(
      `${missing.length} setting${missing.length === 1 ? " is" : "s are"} missing`,
      missing.map((m) => `${m.key} — find it at: ${m.where}`).join("\n"),
    );
  }

  // The single most common mistake: pasting the connection string and never
  // swapping the placeholder for the real database password.
  for (const key of ["DIRECT_URL", "DATABASE_URL"]) {
    if (/\[?(YOUR-PASSWORD|PASSWORD)\]?/i.test(process.env[key]!)) {
      throw new SetupError(
        `${key} still has the word PASSWORD in it`,
        `Replace PASSWORD in ${key} with your Supabase database password — the one ` +
          `you chose when you created the project.\n\nForgotten it? Supabase → Project ` +
          `Settings → Database → Reset database password. Then update BOTH connection strings.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Connection
// ---------------------------------------------------------------------------

async function connect(): Promise<postgres.Sql> {
  const sql = postgres(process.env.DIRECT_URL!, {
    max: 1,
    prepare: false,
    connect_timeout: 20,
    onnotice: () => {},
  });

  try {
    await sql`select 1`;
    return sql;
  } catch (err) {
    await sql.end({ timeout: 1 }).catch(() => {});
    const message = (err as Error).message ?? "";

    if (/password authentication failed/i.test(message)) {
      throw new SetupError(
        "Supabase rejected the database password",
        `The password inside DIRECT_URL is wrong.\n\nSupabase → Project Settings → ` +
          `Database → Reset database password, then paste the new one into BOTH ` +
          `connection strings.`,
      );
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      throw new SetupError(
        "Could not find the Supabase server",
        `The address in DIRECT_URL does not resolve. Copy the connection string again ` +
          `from Supabase → Project Settings → Database.`,
      );
    }
    if (/ETIMEDOUT|timeout/i.test(message)) {
      throw new SetupError(
        "Timed out reaching Supabase",
        `The project may still be starting. Wait a minute and try again.`,
      );
    }
    throw new SetupError("Could not connect to the database", message);
  }
}

// ---------------------------------------------------------------------------
// 3. Migrations
// ---------------------------------------------------------------------------

/**
 * Locate db/migrations, whether running from the repo root or from inside a
 * serverless bundle where the working directory is elsewhere.
 */
async function migrationsDir(): Promise<string> {
  const candidates = [
    path.join(process.cwd(), "db", "migrations"),
    path.join(process.cwd(), "..", "db", "migrations"),
    path.join(process.cwd(), ".next", "server", "db", "migrations"),
  ];
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir);
      if (entries.some((e) => e.endsWith(".sql"))) return dir;
    } catch {
      // try the next one
    }
  }
  throw new SetupError(
    "Could not find the database setup files",
    `Looked in:\n${candidates.join("\n")}\n\nThis is a packaging problem, not ` +
      `something you did wrong.`,
  );
}

async function runMigrations(sql: postgres.Sql): Promise<number> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const contents = await readFile(path.join(dir, file), "utf8");
    try {
      // .simple() selects the simple query protocol, which is what allows a
      // file of many statements -- including $$ quoted function bodies -- to be
      // sent in one go. The extended protocol permits exactly one statement.
      await sql.unsafe(contents).simple();
    } catch (err) {
      throw new SetupError(
        `Setup file ${file} did not apply`,
        `${(err as Error).message}\n\nThese files are written to be safe to re-run, ` +
          `so having run some already is not the cause.`,
      );
    }
  }
  return files.length;
}

// ---------------------------------------------------------------------------
// 4. The login
// ---------------------------------------------------------------------------

const WORDS = ["harbor", "cobalt", "ember", "quartz", "meadow", "lantern", "cedar", "ripple"];

export function generatePassword(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function ensureLogin(sql: postgres.Sql, password: string): Promise<void> {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let authId: string;

  const created = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password,
    email_confirm: true,
  });

  if (created.data?.user) {
    authId = created.data.user.id;
  } else {
    const message = created.error?.message ?? "";

    if (/invalid|api key|jwt|unauthorized/i.test(message)) {
      throw new SetupError(
        "Supabase rejected the service_role key",
        `SUPABASE_SERVICE_ROLE_KEY is wrong, or belongs to a different project. ` +
          `Copy it again from Supabase → Project Settings → API → service_role.`,
      );
    }
    if (!/already|registered|exists/i.test(message)) {
      throw new SetupError("Could not create the login", message);
    }

    // Left over from a previous run. Reuse it and reset the password, so the
    // one reported back is always the one that actually works.
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    const existing = data?.users.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL);
    if (!existing) {
      throw new SetupError(
        "A login for this email exists but could not be read back",
        `Delete ${ADMIN_EMAIL} under Supabase → Authentication → Users, then run this again.`,
      );
    }
    authId = existing.id;
    await admin.auth.admin.updateUserById(existing.id, { password });
  }

  // Connect the Supabase login to the CRM user row. Without this the app signs
  // you in successfully and then cannot work out who you are.
  const linked = await sql`
    update users set auth_id = ${authId}::uuid where email = ${ADMIN_EMAIL} returning id
  `;
  if (linked.length === 0) {
    throw new SetupError(
      `No CRM profile found for ${ADMIN_EMAIL}`,
      `The sample data should have created it. Run setup again.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * A smaller dataset for the browser route.
 *
 * The full 20,000 activities take longer than a serverless function is allowed
 * to run. This still fills every screen and keeps all the planted edge cases;
 * the terminal path loads the full set.
 */
export const BROWSER_VOLUMES: SeedVolumes = {
  users: 40,
  accounts: 300,
  contacts: 1200,
  opportunities: 500,
  activities: 6000,
  days: 180,
};

export async function runSetup(options: {
  volumes?: SeedVolumes;
  password?: string;
} = {}): Promise<SetupResult> {
  const volumes = options.volumes ?? DEFAULT_VOLUMES;
  const password = options.password ?? generatePassword();
  const steps: SetupStep[] = [];

  const fail = (err: SetupError): SetupResult => ({
    ok: false,
    steps,
    problem: { problem: err.problem, fix: err.fix },
  });

  try {
    checkEnvironment();
    steps.push({ name: "Checking your settings", status: "ok", detail: "all five present" });
  } catch (err) {
    steps.push({ name: "Checking your settings", status: "failed", detail: (err as Error).message });
    return fail(err as SetupError);
  }

  let sql: postgres.Sql;
  try {
    sql = await connect();
    steps.push({ name: "Connecting to Supabase", status: "ok", detail: "connected" });
  } catch (err) {
    steps.push({ name: "Connecting to Supabase", status: "failed", detail: (err as Error).message });
    return fail(err as SetupError);
  }

  try {
    const count = await runMigrations(sql);
    steps.push({
      name: "Creating tables and permission rules",
      status: "ok",
      detail: `${count} files applied`,
    });

    const db = drizzle(sql, { schema }) as unknown as Db;
    const report = await seed(db, volumes);
    steps.push({
      name: "Loading sample data",
      status: "ok",
      detail: `${report.accounts} companies, ${report.contacts} contacts, ${report.activities.toLocaleString()} calls and emails`,
    });

    await ensureLogin(sql, password);
    steps.push({ name: "Creating your login", status: "ok", detail: ADMIN_EMAIL });

    return {
      ok: true,
      steps,
      login: { email: ADMIN_EMAIL, password },
      stats: {
        accounts: report.accounts,
        contacts: report.contacts,
        activities: report.activities,
        qualifyingRate: `${((report.qualifyingActivities / report.activities) * 100).toFixed(0)}%`,
      },
      landmarks: report.landmarks,
    };
  } catch (err) {
    const setupErr =
      err instanceof SetupError
        ? err
        : new SetupError("Setup did not finish", (err as Error).message ?? String(err));
    steps.push({ name: "Setting up", status: "failed", detail: setupErr.problem });
    return fail(setupErr);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
