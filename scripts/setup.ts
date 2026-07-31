/**
 * One-command setup.
 *
 *   npm run setup
 *
 * Replaces the manual routine of pasting three SQL files into the Supabase
 * editor, running the seed, hand-creating an auth user, copying its UID, and
 * running one more query to link it. Every one of those steps is a place to
 * mistype something and get an error that does not explain itself.
 *
 * Safe to run more than once. Migrations are guarded, the seed rebuilds from
 * scratch, and an existing login is reused rather than duplicated.
 *
 * Everything it does can still be done by hand -- see README. This is the same
 * work, automated, with the failure messages written in advance.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { DEFAULT_VOLUMES, seed, type SeedVolumes } from "../db/seed";
import * as schema from "../src/lib/db/schema";
import type { Db } from "../src/lib/matcher";

const ADMIN_EMAIL = "avery.stone@megaforce.test";
const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

// --- output helpers --------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let stepNumber = 0;
function step(label: string) {
  stepNumber += 1;
  process.stdout.write(`${dim(`[${stepNumber}/5]`)} ${label}... `);
}
function ok(detail = "done") {
  console.log(green(detail));
}

/** Stops the script with an explanation and what to do about it. */
class SetupError extends Error {
  constructor(
    readonly problem: string,
    readonly fix: string,
  ) {
    super(problem);
  }
}

// --- 1. check the environment ---------------------------------------------

const REQUIRED: { key: string; where: string }[] = [
  {
    key: "DIRECT_URL",
    where: "Supabase → Project Settings → Database → Connection string → URI, the one on port 5432",
  },
  {
    key: "DATABASE_URL",
    where: "same screen, the one on port 6543",
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_URL",
    where: "Supabase → Project Settings → API → Project URL",
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    where: "Supabase → Project Settings → API → anon public",
  },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    where: "Supabase → Project Settings → API → service_role",
  },
];

function checkEnvironment() {
  const missing = REQUIRED.filter(({ key }) => !process.env[key]?.trim());
  if (missing.length > 0) {
    const list = missing.map((m) => `    ${bold(m.key)}\n      find it: ${m.where}`).join("\n");
    throw new SetupError(
      `${missing.length} value(s) missing from .env.local`,
      `Open .env.local and fill in:\n\n${list}\n\n` +
        `  If .env.local does not exist yet, run:  cp .env.example .env.local`,
    );
  }

  // The single most common mistake: copying the connection string but never
  // replacing the placeholder with the real database password.
  for (const key of ["DIRECT_URL", "DATABASE_URL"]) {
    const value = process.env[key]!;
    if (/\[?(YOUR-PASSWORD|PASSWORD)\]?/i.test(value)) {
      throw new SetupError(
        `${key} still contains the placeholder password`,
        `Open .env.local and replace PASSWORD in ${key} with the database password\n` +
          `  you chose when you created the Supabase project.\n\n` +
          `  Forgotten it? Supabase → Project Settings → Database → Reset database password.`,
      );
    }
  }

  if (!/:5432\//.test(process.env.DIRECT_URL!)) {
    console.log(
      `\n${dim("note:")} DIRECT_URL is usually the port 5432 connection string. ` +
        `Migrations against the\n      pooled port can half-apply. Continuing anyway.`,
    );
  }
}

// --- 2. connect ------------------------------------------------------------

async function connect() {
  const sql = postgres(process.env.DIRECT_URL!, {
    max: 1,
    prepare: false,
    connect_timeout: 20,
    onnotice: () => {},
  });

  try {
    await sql`select 1`;
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/password authentication failed/i.test(message)) {
      throw new SetupError(
        "Supabase rejected the database password",
        `The password inside DIRECT_URL is wrong.\n\n` +
          `  Supabase → Project Settings → Database → Reset database password,\n` +
          `  then paste the new one into BOTH connection strings in .env.local.`,
      );
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      throw new SetupError(
        "Could not reach the Supabase host",
        `The hostname in DIRECT_URL does not resolve. Copy the connection string\n` +
          `  again from Supabase → Project Settings → Database, and check you are online.`,
      );
    }
    if (/ETIMEDOUT|timeout/i.test(message)) {
      throw new SetupError(
        "Timed out connecting to Supabase",
        `The project may still be starting up. Wait a minute and run this again.`,
      );
    }
    throw new SetupError("Could not connect to the database", message);
  }

  return sql;
}

// --- 3. migrations ---------------------------------------------------------

async function runMigrations(sql: postgres.Sql) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new SetupError("No migration files found", `Expected .sql files in ${MIGRATIONS_DIR}`);

  for (const file of files) {
    const contents = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      // .simple() uses the simple query protocol, which is what allows a file
      // of many statements -- including dollar-quoted function bodies -- to be
      // sent in one round trip.
      await sql.unsafe(contents).simple();
    } catch (err) {
      throw new SetupError(
        `Migration ${file} failed`,
        `${(err as Error).message}\n\n` +
          `  If you already ran some of these by hand in the SQL editor, that is fine --\n` +
          `  they are written to be safely re-runnable. This error means something else.`,
      );
    }
  }
  return files.length;
}

// --- 4. the login ----------------------------------------------------------

function generatePassword(): string {
  // Readable, typeable, and different every run. Printed once at the end.
  const words = ["harbor", "cobalt", "ember", "quartz", "meadow", "lantern", "cedar", "ripple"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function ensureLogin(sql: postgres.Sql, password: string) {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let authId: string | null = null;

  const created = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password,
    email_confirm: true,
  });

  if (created.data?.user) {
    authId = created.data.user.id;
  } else {
    const message = created.error?.message ?? "";
    if (!/already|registered|exists/i.test(message)) {
      if (/invalid|api key|jwt/i.test(message)) {
        throw new SetupError(
          "Supabase rejected the service_role key",
          `SUPABASE_SERVICE_ROLE_KEY in .env.local is wrong or belongs to a different project.\n` +
            `  Copy it again from Supabase → Project Settings → API → service_role.`,
        );
      }
      throw new SetupError("Could not create the login", message);
    }

    // Already there from a previous run: find it and reset the password so the
    // one printed at the end is always the one that works.
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

  // Link the Supabase login to the CRM user row. Without this the app signs you
  // in and then cannot work out who you are.
  const linked = await sql`
    update users set auth_id = ${authId}::uuid where email = ${ADMIN_EMAIL} returning id
  `;

  if (linked.length === 0) {
    throw new SetupError(
      `No CRM user row for ${ADMIN_EMAIL}`,
      `The seed should have created it. Run this script again -- it reseeds from scratch.`,
    );
  }

  return authId;
}

// --- main ------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const small = argv.includes("--small");
  const volumes: SeedVolumes = small
    ? { users: 10, accounts: 40, contacts: 120, opportunities: 60, activities: 600, days: 180 }
    : DEFAULT_VOLUMES;

  const passwordArg = argv.find((a) => a.startsWith("--password="));
  const password = passwordArg ? passwordArg.split("=")[1] : generatePassword();

  console.log(`\n${bold("Megaforce CRM setup")}\n`);

  step("Checking .env.local");
  checkEnvironment();
  ok();

  step("Connecting to Supabase");
  const sql = await connect();
  ok();

  try {
    step("Creating tables and permission rules");
    const count = await runMigrations(sql);
    ok(`${count} migration files applied`);

    step(`Loading ${volumes.activities.toLocaleString()} synthetic activities`);
    const db = drizzle(sql, { schema }) as unknown as Db;
    const report = await seed(db, volumes);
    ok(`${report.accounts} accounts, ${report.contacts} contacts`);

    step("Creating your login");
    await ensureLogin(sql, password);
    ok();

    const rate = ((report.qualifyingActivities / report.activities) * 100).toFixed(0);

    console.log(`\n${green(bold("Ready."))}\n`);
    console.log(`  Sign in with:`);
    console.log(`    email     ${bold(ADMIN_EMAIL)}`);
    console.log(`    password  ${bold(password)}   ${dim("← write this down")}\n`);
    console.log(`  Then run:   ${bold("npm run dev")}`);
    console.log(`  And open:   ${bold("http://localhost:3000")}\n`);
    console.log(dim(`  ${rate}% of the loaded activity qualified under the current rules.`));
    if (report.landmarks.ambiguousPhone) {
      console.log(
        dim(`  Demo tip: ${report.landmarks.ambiguousPhone} is on file at two different companies.`),
      );
      console.log(dim(`  Run "npm run simulate -- --remote" to send it a call and watch it queue.`));
    }
    console.log("");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  if (err instanceof SetupError) {
    console.log(red("failed"));
    console.log(`\n${red(bold("Stopped: " + err.problem))}\n`);
    console.log(`  ${err.fix}\n`);
    process.exit(1);
  }
  console.log(red("failed"));
  console.error(`\n${red("Unexpected error:")}\n`, err);
  process.exit(1);
});
