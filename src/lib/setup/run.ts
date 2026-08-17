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
import { supabaseSecretKey } from "@/lib/supabase/keys";

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

/**
 * Each required setting, and every name it is accepted under.
 *
 * The API keys have two spellings because Supabase renamed them: projects
 * created before the change issue `anon` and `service_role`, newer ones issue
 * `sb_publishable_…` and `sb_secret_…`. Both work. Accepting either name means
 * whatever the dashboard shows can be pasted under the label printed beside it,
 * with no working out which era the project belongs to.
 */
const REQUIRED: { names: string[]; where: string }[] = [
  {
    names: ["DIRECT_URL"],
    where: "Supabase → Connect → Session pooler, the string containing port 5432",
  },
  {
    names: ["DATABASE_URL"],
    where: "Supabase → Connect → Transaction pooler, the string containing port 6543",
  },
  {
    names: ["NEXT_PUBLIC_SUPABASE_URL"],
    where: "Supabase → Project Settings → API → Project URL",
  },
  {
    names: ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    where: "Supabase → Project Settings → API Keys → the publishable (or anon) key",
  },
  {
    names: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
    where: "Supabase → Project Settings → API Keys → the secret (or service_role) key",
  },
];

/** First of the accepted names that is actually set. */
function resolve(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The Supabase project URL, cleaned up.
 *
 * Pasting into a web form very easily carries a trailing space or newline, and
 * a URL with whitespace in it does not fail with "bad URL" -- it fails deep
 * inside fetch with a bare "fetch failed", which points nowhere useful.
 * Trailing slashes are dropped for the same reason.
 */
export function supabaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
}

/**
 * Unwrap the real reason behind a thrown error.
 *
 * Node's fetch reports nearly every network problem as the single word "fetch
 * failed" and hides the actual cause -- ENOTFOUND, ECONNREFUSED, a TLS failure
 * -- one level down in `cause`. Reporting only the top-level message leaves
 * someone staring at two words that describe every possible failure equally.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { message?: string; code?: string; cause?: unknown };
    const piece = [e.message, e.code && e.code !== e.message ? `(${e.code})` : null]
      .filter(Boolean)
      .join(" ");
    if (piece && !parts.includes(piece)) parts.push(piece);
    current = e.cause;
  }
  return parts.join(" — ") || String(err);
}

export function checkEnvironment(): void {
  const missing = REQUIRED.filter(({ names }) => !resolve(names));
  if (missing.length > 0) {
    throw new SetupError(
      `${missing.length} setting${missing.length === 1 ? " is" : "s are"} missing`,
      missing
        .map((m) => `${m.names[0]}${m.names[1] ? ` (or ${m.names[1]})` : ""} — find it at: ${m.where}`)
        .join("\n"),
    );
  }

  // A project URL with a stray space or newline -- trivially easy when pasting
  // into a web form -- does not fail as "bad URL". It fails deep inside fetch
  // as a bare "fetch failed", which describes every possible network problem
  // equally and so points at none of them.
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (/\s/.test(rawUrl.trim())) {
    throw new SetupError(
      "NEXT_PUBLIC_SUPABASE_URL has a space in the middle of it",
      `It should be one unbroken web address, like https://yourproject.supabase.co\n\n` +
        `Re-copy it from Supabase → Project Settings → API → Project URL, and make sure ` +
        `nothing was picked up along with it.`,
    );
  }
  if (!/^https?:\/\/[^\s/]+/i.test(rawUrl.trim())) {
    throw new SetupError(
      "NEXT_PUBLIC_SUPABASE_URL does not look like a web address",
      `Got: ${rawUrl.trim().slice(0, 80) || "(empty)"}\n\n` +
        `It should start with https:// and look like https://yourproject.supabase.co\n\n` +
        `Copy it from Supabase → Project Settings → API → Project URL.`,
    );
  }

  for (const key of ["DIRECT_URL", "DATABASE_URL"]) {
    const password = passwordFrom(process.env[key]!);

    // The single most common mistake: pasting the connection string and never
    // swapping the placeholder for the real database password.
    //
    // Matched against the extracted password segment only, and anchored. A
    // loose substring search rejects the perfectly valid password
    // "hunter2password" for containing the word.
    if (password !== null && /^\[?your[-_ ]?password\]?$|^\[?password\]?$/i.test(password)) {
      throw new SetupError(
        `${key} still has the placeholder instead of your password`,
        `Replace ${password} in ${key} with your Supabase database password — the one ` +
          `you chose when you created the project.\n\nForgotten it? Supabase → Project ` +
          `Settings → Database → Reset database password. Then update BOTH connection strings.`,
      );
    }

    const offending = unencodedPasswordCharacters(password);
    if (offending) {
      throw new SetupError(
        `The password in ${key} contains ${offending} and needs escaping`,
        `A connection string is a web address, so certain characters in the password ` +
          `have to be written differently or they break it.\n\n` +
          `By far the easiest fix: Supabase → Project Settings → Database → Reset ` +
          `database password, and choose one with only letters, numbers and dashes. ` +
          `Then paste it into BOTH connection strings.\n\n` +
          `Or escape them by hand:  @ → %40   : → %3A   / → %2F   ` +
          `? → %3F   # → %23   space → %20`,
      );
    }
  }
}

/**
 * Pull the password out of a connection string, exactly as a URL parser would.
 *
 * The userinfo section ends at the LAST "@", not the first -- which is the
 * whole reason an unescaped "@" inside a password is so destructive.
 */
function passwordFrom(connectionString: string): string | null {
  const afterScheme = connectionString.split("://")[1];
  if (!afterScheme) return null;

  const lastAt = afterScheme.lastIndexOf("@");
  if (lastAt === -1) return null;

  const userinfo = afterScheme.slice(0, lastAt);
  const firstColon = userinfo.indexOf(":");
  if (firstColon === -1) return null;

  return userinfo.slice(firstColon + 1);
}

/**
 * Detect a password pasted in raw when it needed percent-encoding.
 *
 * Supabase warns about this beside the connection string, in text nobody reads,
 * and the consequence is an authentication failure that blames the password
 * rather than its punctuation. With an unescaped "@" it is worse still: the
 * connection is redirected to a hostname that does not exist, so the error
 * points at the host.
 *
 * Returns a human-readable list of the offending characters, or null.
 */
function unencodedPasswordCharacters(password: string | null): string | null {
  if (!password) return null;

  // A "%" followed by two hex digits is already encoded and correct; strip
  // those before looking for trouble, so %40 is not read as a stray character.
  const raw = password.replace(/%[0-9a-f]{2}/gi, "");
  const bad = [...new Set(raw.split("").filter((c) => ":/?#[]@ ".includes(c)))];
  if (bad.length === 0) return null;

  const named = bad.map((c) => (c === " " ? "a space" : `"${c}"`));
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
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

/**
 * Every Supabase login that exists, read straight out of the database.
 *
 * Used to offer a choice rather than demand an exact address. Nobody should
 * have to match a placeholder email invented by a seed script.
 */
export async function listAuthLogins(
  sql: postgres.Sql,
): Promise<{ id: string; email: string }[]> {
  // Ordered by email, not by creation time. Newest-first would read slightly
  // better, but this is the path someone reaches when something else has
  // already failed, so it leans on the fewest columns it can: id and email are
  // the two that cannot move.
  const rows = await sql<{ id: string; email: string | null }[]>`
    select id, email from auth.users where email is not null order by email limit 50
  `;
  return rows
    .filter((r): r is { id: string; email: string } => Boolean(r.email))
    .map((r) => ({ id: r.id, email: r.email }));
}

/**
 * Attach an existing Supabase login to the CRM's admin profile, using SQL only.
 *
 * Supabase keeps its users in an `auth.users` table in the same database we are
 * already connected to. That matters: when the Auth REST API is unreachable,
 * this path still works, because it never leaves the database connection that
 * has already proven itself by running the migrations.
 *
 * The admin profile is found by ROLE, not by address, and its email is then
 * updated to match the login. Whatever address was used to create the login in
 * the dashboard becomes the right one, rather than the seed's placeholder.
 *
 * Returns false when no Supabase login exists for the address yet.
 */
export async function linkExistingLogin(
  sql: postgres.Sql,
  email: string = ADMIN_EMAIL,
): Promise<boolean> {
  const target = email.trim().toLowerCase();

  const found = await sql<{ id: string }[]>`
    select id from auth.users where lower(email) = ${target} limit 1
  `;
  if (found.length === 0) return false;

  // Clear the link from any other profile first: auth_id is unique, so a
  // previous attempt pointing at a different row would otherwise collide.
  await sql`update users set auth_id = null where auth_id = ${found[0].id}::uuid`;

  const linked = await sql<{ id: string }[]>`
    update users
       set auth_id = ${found[0].id}::uuid,
           email   = ${target}
     where id = (select id from users where role = 'admin' order by created_at limit 1)
    returning id
  `;

  if (linked.length === 0) {
    throw new SetupError(
      "No admin profile found in the CRM",
      `The sample data should have created one. Run the full setup again.`,
    );
  }
  return true;
}

/** What to tell someone whose Auth API could not be reached. */
function manualLoginInstructions(detail: string): SetupError {
  return new SetupError(
    "Could not reach Supabase's login service",
    `Everything else worked — your database is built and full of data. Only the ` +
      `login step failed.\n\nUnderlying error: ${detail}\n\n` +
      `Create the login by hand instead. It takes about thirty seconds:\n\n` +
      `1. In Supabase, go to Authentication → Users → Add user → Create new user.\n` +
      `2. Email: ${ADMIN_EMAIL}\n` +
      `3. Password: anything you like, and write it down.\n` +
      `4. Tick "Auto Confirm User", then create it.\n` +
      `5. Come back and add &link=1 to the end of this page's web address.\n\n` +
      `That last step connects the login you just made to the CRM, without ` +
      `needing Supabase's login service at all.`,
  );
}

async function ensureLogin(sql: postgres.Sql, password: string): Promise<void> {
  const url = supabaseUrl();
  const admin = createClient(url, supabaseSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let authId: string;

  let created: Awaited<ReturnType<typeof admin.auth.admin.createUser>>;
  try {
    created = await admin.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password,
      email_confirm: true,
    });
  } catch (err) {
    // The Auth API is unreachable -- a bad project URL, stray whitespace in it,
    // or a network problem. If a login happens to exist already we can still
    // finish over SQL; otherwise explain the manual route.
    if (await linkExistingLogin(sql)) return;
    throw manualLoginInstructions(describeError(err));
  }

  if (created.data?.user) {
    authId = created.data.user.id;
  } else {
    const message = created.error?.message ?? "";

    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|socket/i.test(message)) {
      if (await linkExistingLogin(sql)) return;
      throw manualLoginInstructions(message);
    }
    if (/invalid|api key|jwt|unauthorized|signature/i.test(message)) {
      throw new SetupError(
        "Supabase rejected your secret key",
        `SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is wrong, or belongs to a ` +
          `different project.\n\nCopy it again from Supabase → Project Settings → ` +
          `API Keys → the secret key. Make sure no spaces came along with it.\n\n` +
          `Underlying error: ${message}`,
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
      // The API says it exists but will not hand it over. SQL can see it.
      if (await linkExistingLogin(sql)) return;
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

/**
 * The logins available to choose from, with the connection opened and closed
 * for us.
 *
 * Returns the reason on failure rather than an empty list. An earlier version
 * swallowed errors and returned [], which made "the auth schema is not readable
 * by this role" indistinguishable from "you have not made a login yet" -- and
 * so told someone staring at their login in the Supabase dashboard that it did
 * not exist. Reporting nothing found when the truth is that we could not look
 * is worse than reporting the error.
 */
export async function fetchAuthLogins(): Promise<{
  logins: { id: string; email: string }[];
  error?: string;
}> {
  let sql: postgres.Sql;
  try {
    checkEnvironment();
    sql = await connect();
  } catch (err) {
    return { logins: [], error: describeError(err) };
  }
  try {
    return { logins: await listAuthLogins(sql) };
  } catch (err) {
    return { logins: [], error: describeError(err) };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Attach a login by its identifier, pasted straight from the Supabase
 * dashboard's Users table.
 *
 * This is the path that cannot fail for lack of permission. Supabase keeps
 * auth.users under a schema owned by its own role, and a project may not grant
 * the application's role read access to it -- so listing the logins can be
 * refused even though the login plainly exists. Writing our OWN users table
 * never is.
 *
 * The UID is visible in the dashboard next to the login, so this asks for
 * something already on screen rather than something to go and derive.
 */
export async function linkByAuthId(
  sql: postgres.Sql,
  authId: string,
  email?: string,
): Promise<void> {
  const id = authId.trim();
  if (!UUID.test(id)) {
    throw new SetupError(
      "That does not look like a user ID",
      `Expected something shaped like 52a67572-7bce-405d-93a3-77b8601ffc8d.\n\n` +
        `Find it in Supabase under Authentication → Users, in the UID column ` +
        `beside your login.\n\nGot: ${id.slice(0, 60) || "(empty)"}`,
    );
  }

  // auth_id is unique, so clear any previous pointer before re-aiming it.
  await sql`update users set auth_id = null where auth_id = ${id}::uuid`;

  const address = email?.trim().toLowerCase();
  const linked = address
    ? await sql<{ id: string }[]>`
        update users set auth_id = ${id}::uuid, email = ${address}
         where id = (select id from users where role = 'admin' order by created_at limit 1)
        returning id`
    : await sql<{ id: string }[]>`
        update users set auth_id = ${id}::uuid
         where id = (select id from users where role = 'admin' order by created_at limit 1)
        returning id`;

  if (linked.length === 0) {
    throw new SetupError(
      "No admin profile found in the CRM",
      `The sample data should have created one. Run the full setup again.`,
    );
  }
}

/**
 * Link-only mode: skip migrations and seeding, just attach a login that already
 * exists in Supabase. For when the Auth API could not be reached and the user
 * created the login through the dashboard instead.
 */
export async function runLinkOnly(options: {
  email?: string;
  /** Pasted from the dashboard. Takes precedence, since it cannot be refused. */
  authId?: string;
} = {}): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  try {
    checkEnvironment();
    steps.push({ name: "Checking your settings", status: "ok", detail: "all five present" });
  } catch (err) {
    const e = err as SetupError;
    steps.push({ name: "Checking your settings", status: "failed", detail: e.problem });
    return { ok: false, steps, problem: { problem: e.problem, fix: e.fix } };
  }

  let sql: postgres.Sql;
  try {
    sql = await connect();
    steps.push({ name: "Connecting to Supabase", status: "ok", detail: "connected" });
  } catch (err) {
    const e = err as SetupError;
    steps.push({ name: "Connecting to Supabase", status: "failed", detail: e.problem });
    return { ok: false, steps, problem: { problem: e.problem, fix: e.fix } };
  }

  try {
    // The pasted identifier wins. Looking a login up by address needs read
    // access to Supabase's auth schema, which a project may not grant; writing
    // our own table never needs anyone's permission.
    if (options.authId) {
      await linkByAuthId(sql, options.authId, options.email);
      steps.push({
        name: "Linking your login",
        status: "ok",
        detail: options.email?.trim() || options.authId.trim(),
      });
      return {
        ok: true,
        steps,
        login: {
          email: options.email?.trim() || "(the address you used in Supabase)",
          password: "(the one you chose in Supabase)",
        },
      };
    }

    const target = (options.email ?? ADMIN_EMAIL).trim().toLowerCase();
    const linked = await linkExistingLogin(sql, target);

    if (!linked) {
      steps.push({ name: "Linking your login", status: "failed", detail: "no such login yet" });

      // Say which logins DO exist. "Not found" plus a list of what was found is
      // a fix; "not found" on its own is a puzzle.
      const existing = await listAuthLogins(sql);
      const found = existing.length
        ? `\n\nLogins that DO exist in this project:\n${existing.map((l) => `  • ${l.email}`).join("\n")}`
        : `\n\nThere are no Supabase logins in this project yet.`;

      return {
        ok: false,
        steps,
        problem: {
          problem: `No Supabase login found for ${target}`,
          fix:
            `Create it first, or pick one of the addresses below:\n\n` +
            `1. In Supabase, go to Authentication → Users → Add user → Create new user.\n` +
            `2. Use any email you like.\n` +
            `3. Password: anything, and write it down.\n` +
            `4. Tick "Auto Confirm User", then create it.\n` +
            `5. Load this page again.` +
            found,
        },
      };
    }

    steps.push({ name: "Linking your login", status: "ok", detail: target });
    return {
      ok: true,
      steps,
      login: { email: target, password: "(the one you chose in Supabase)" },
    };
  } catch (err) {
    const e =
      err instanceof SetupError
        ? err
        : new SetupError("Could not link the login", describeError(err));
    steps.push({ name: "Linking your login", status: "failed", detail: e.problem });
    return { ok: false, steps, problem: { problem: e.problem, fix: e.fix } };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
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

    /*
     * Remember any login already attached, BEFORE the seed wipes the users
     * table.
     *
     * Seeding rebuilds every user row, which silently severs the connection
     * between a Supabase login and its CRM profile -- so someone who reseeds to
     * pick up new sample data is locked out of the app they just reloaded, with
     * no hint that the two events are related. Capturing the link here and
     * restoring it below makes reseeding safe to repeat, which matters because
     * reseeding is exactly what someone does while still finding their feet.
     */
    const existing = await sql<{ auth_id: string; email: string }[]>`
      select auth_id, email from users
       where auth_id is not null and role in ('admin','credit')
       order by case role when 'admin' then 0 else 1 end
       limit 1
    `;
    const preserved = existing[0] ?? null;

    const db = drizzle(sql, { schema }) as unknown as Db;
    const report = await seed(db, volumes);

    // Belt and braces on top of the seed's own sweep. Setup is the one moment
    // the whole book is rewritten, and an account left owned past its deadline
    // here is the first thing anybody sees -- indistinguishable from the
    // release being broken.
    await sql`select release_overdue_accounts()`;
    steps.push({
      name: "Loading sample data",
      status: "ok",
      detail: `${report.accounts} companies, ${report.contacts} contacts, ${report.activities.toLocaleString()} calls and emails`,
    });

    if (preserved) {
      // Reattach the login that already worked, and keep its address. No new
      // password is issued: the one they wrote down still signs them in.
      await linkByAuthId(sql, preserved.auth_id, preserved.email);
      steps.push({
        name: "Reconnecting your existing login",
        status: "ok",
        detail: preserved.email,
      });

      return {
        ok: true,
        steps,
        login: { email: preserved.email, password: "(unchanged — the one you already use)" },
        stats: {
          accounts: report.accounts,
          contacts: report.contacts,
          activities: report.activities,
          qualifyingRate: `${((report.qualifyingActivities / report.activities) * 100).toFixed(0)}%`,
        },
        landmarks: report.landmarks,
      };
    }

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
        : new SetupError("Setup did not finish", describeError(err));
    steps.push({ name: "Setting up", status: "failed", detail: setupErr.problem });
    return fail(setupErr);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
