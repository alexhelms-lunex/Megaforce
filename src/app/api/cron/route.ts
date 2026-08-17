import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { findJob, runDueJobs, runJob, type JobContext } from "@/lib/jobs/registry";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The digest walks every broker. On a large book that is not a two-second job,
// and a timeout halfway through would leave half the floor without their email.
export const maxDuration = 300;

const log = logger.child({ component: "cron" });

/**
 * The scheduler's front door.
 *
 * Vercel Cron calls this on the schedule in vercel.json, with
 * `Authorization: Bearer $CRON_SECRET`. Chosen over a third-party job runner
 * because it needs no extra service, no extra account, and no extra thing to
 * remember to keep alive -- and the reason this endpoint exists at all is that
 * the last scheduled job was never actually wired up to anything.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEDULE IS DAILY, NOT HOURLY, AND THAT IS NOT A PREFERENCE.
 *
 * Vercel's Hobby plan permits a cron to fire once per day. An hourly
 * expression is rejected at deployment-config validation -- which runs BEFORE
 * the build, so the deployment is never created at all. No error appears in the
 * deployments list, because there is no deployment.
 *
 * That is precisely what happened here: an hourly schedule was committed and
 * silently blocked seven consecutive pushes from ever reaching production. The
 * application looked frozen for a day while every fix sat in the repository
 * unbuilt, and the symptom -- old behaviour persisting after a "redeploy" --
 * pointed at everything except the deployment config.
 *
 * 09:00 UTC is 5am Eastern in summer, 4am in winter. The exact hour matters
 * less than it looks: each job re-checks whether it is its turn against the
 * hour and timezone in settings, so the send time stays editable in the
 * application. On a plan that allows more frequent crons, raising the frequency
 * here makes that check tighter -- it does not change what any job does.
 * ---------------------------------------------------------------------------
 */
export async function GET(req: Request) {
  if (!authorised(req)) {
    // Deliberately terse. An unauthenticated caller learns nothing about which
    // jobs exist or when they run.
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("job");
  const ctx: JobContext = { trigger: "schedule", utcHour: new Date().getUTCHours() };

  if (only) {
    const job = findJob(only);
    if (!job) return NextResponse.json({ error: `no job named ${only}` }, { status: 404 });
    const summary = await runJob(job, { ...ctx, trigger: "manual" });
    return NextResponse.json({ runs: [summary] });
  }

  const runs = await runDueJobs(ctx);
  log.info({ runs }, "cron finished");

  // 200 even when a job failed. A non-2xx makes Vercel retry the whole batch,
  // which would re-run the jobs that succeeded; the failure is recorded in
  // job_runs and shown on the Admin screen, which is where it belongs.
  return NextResponse.json({ ranAt: new Date().toISOString(), runs });
}

function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // No secret configured means the endpoint is closed, not open. An unprotected
  // route that releases accounts is not something to leave to a missing env var.
  if (!expected) return false;

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Burn an equivalent comparison so timing does not distinguish a wrong
    // length from wrong contents.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
