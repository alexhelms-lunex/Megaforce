import { NextResponse } from "next/server";
import { createClient, currentUser } from "@/lib/supabase/server";
import { clearErrors, recentErrors, type CapturedError } from "@/instrumentation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What actually went wrong.
 *
 * ---------------------------------------------------------------------------
 * Production redacts server errors, so a broken screen says only that one
 * occurred. This is where the real message lives: captured by the
 * onRequestError hook before Next hides it, held in memory, and readable by an
 * administrator.
 *
 * ADMIN ONLY, and that is not a formality. A stack trace names files, and an
 * error message can quote a connection string or a row somebody should not
 * see. Anybody else gets 404 rather than 403 -- a 403 confirms the endpoint
 * exists, which is a small thing to give away for no benefit.
 *
 * Errors are per-instance and per-deployment: serverless instances are
 * created and discarded, so this shows what THIS one has seen. That is enough
 * for the ten minutes after something breaks, which is what it is for.
 * ---------------------------------------------------------------------------
 */
export async function GET(req: Request) {
  const me = await currentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (new URL(req.url).searchParams.get("clear") === "1") {
    const cleared = recentErrors().length;
    clearErrors();
    return NextResponse.json({ cleared });
  }

  /*
   * The table first, this instance's memory second.
   *
   * The in-memory copy is per-instance, and Vercel discards instances
   * constantly -- so on its own it answered "nothing has failed here" seconds
   * after something had, which reads as evidence that the error is not real.
   * The table is written by every instance and read by every instance.
   *
   * Memory is still merged in, because it is the one thing that still works
   * when the database is the thing that broke.
   */
  const stored = await fromTable();
  const inMemory = recentErrors();

  const seen = new Set(stored.map((e) => `${e.at}|${e.message}`));
  const errors = [
    ...stored,
    ...inMemory.filter((e) => !seen.has(`${e.at}|${e.message}`)),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return NextResponse.json(
    {
      note:
        errors.length === 0
          ? "Nothing has been recorded. If a screen just broke and this is empty, the error log table may be missing — re-run /api/setup."
          : "Newest first. These are the real messages, before production redacts them.",
      count: errors.length,
      storedInDatabase: stored.length,
      errors,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function fromTable(): Promise<CapturedError[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("app_errors")
      .select("at, digest, message, path, kind, stack, release")
      .order("at", { ascending: false })
      .limit(25);
    return (data ?? []) as CapturedError[];
  } catch {
    // The table may not exist yet on a database that has not been migrated,
    // and this endpoint has to keep working precisely then.
    return [];
  }
}
