import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import postgres from "postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What is actually running, and what the database actually says.
 *
 * ---------------------------------------------------------------------------
 * This exists because three rounds were lost to the same ambiguity: a fix was
 * written, tested and pushed, and the deployed application did not have it --
 * so the symptom persisted and looked like the fix had failed. Vercel's
 * "Redeploy" button rebuilds the commit you pressed it on, not the newest one,
 * which is a very easy way to redeploy the same old code repeatedly while
 * believing you are updating.
 *
 * Guessing at that from screenshots does not work. This endpoint answers it in
 * one request: which commit is serving, which migrations are in the bundle, and
 * what the live database believes the thresholds are. If the code says 31 and
 * the database says 45, that is a migration that has not run. If the commit is
 * old, that is a deployment problem. The two used to look identical.
 *
 * Deliberately open. It exposes a commit hash, a file listing and three
 * integers -- nothing that is not already public in the repository, and no
 * account data whatsoever. Locking it behind the login would make it useless
 * for diagnosing a login that will not load.
 * ---------------------------------------------------------------------------
 */
export async function GET() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

  const body: Record<string, unknown> = {
    commit: commit ? commit.slice(0, 7) : "unknown (not built on Vercel)",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0] ?? null,
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID ? "see Vercel" : null,
    now: new Date().toISOString(),
  };

  // Which migrations this BUILD carries. If 0017 is missing here, the running
  // code predates the threshold fix and no amount of re-running setup will help.
  try {
    const dir = await findMigrations();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    body.migrationsInBuild = files.length;
    body.latestMigration = files[files.length - 1] ?? null;
  } catch (err) {
    body.migrationsInBuild = `could not read: ${(err as Error).message}`;
  }

  // What the DATABASE currently believes. This is the half that has been
  // invisible: the code can be right and this still be wrong.
  const url = process.env.DATABASE_URL;
  if (!url) {
    body.database = "DATABASE_URL is not set";
    return NextResponse.json(body);
  }

  let sql: postgres.Sql | null = null;
  try {
    sql = postgres(url.trim(), { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });

    const rules = await sql<
      { applies_to: string; warning_days: number; expiring_days: number; release_days: number }[]
    >`select applies_to, warning_days, expiring_days, release_days
        from account_retention_rules where active order by applies_to`;

    const [overdue] = await sql<{ c: string }[]>`
      select count(*)::text c from accounts a
       where a.owner_id is not null
         and account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at,
                           a.retention_override_until) = 'overdue'
    `;

    const [pool] = await sql<{ c: string }[]>`
      select count(*)::text c from accounts where owner_id is null
    `;

    const lastSweep = await sql<{ started_at: string; ok: boolean; result: unknown }[]>`
      select started_at, ok, result from job_runs
       where job = 'release-overdue-accounts'
       order by started_at desc limit 1
    `;

    body.database = {
      thresholds: Object.fromEntries(
        rules.map((r) => [r.applies_to, `${r.warning_days} / ${r.expiring_days} / ${r.release_days}`]),
      ),
      ownedButOverdue: Number(overdue.c),
      availablePool: Number(pool.c),
      lastRelease: lastSweep[0] ?? "never run",
    };

    // The single sentence worth reading.
    const prospect = rules.find((r) => r.applies_to === "prospect");
    body.verdict =
      prospect && prospect.release_days !== 31
        ? `MIGRATION MISSING: prospects release at ${prospect.release_days} days, should be 31. Re-run /api/setup on THIS deployment.`
        : Number(overdue.c) > 0
          ? `${overdue.c} accounts are owned and past their deadline. The release has not run since they crossed it.`
          : "Thresholds correct, nothing owned past its deadline.";
  } catch (err) {
    body.database = `could not read: ${(err as Error).message}`;
  } finally {
    await sql?.end({ timeout: 5 });
  }

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

async function findMigrations(): Promise<string> {
  for (const dir of [
    path.join(process.cwd(), "db", "migrations"),
    path.join(process.cwd(), "..", "db", "migrations"),
    path.join(process.cwd(), ".next", "server", "db", "migrations"),
  ]) {
    try {
      const entries = await readdir(dir);
      if (entries.some((e) => e.endsWith(".sql"))) return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("db/migrations not found in the deployed bundle");
}
