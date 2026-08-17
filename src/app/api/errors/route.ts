import { NextResponse } from "next/server";
import { currentUser } from "@/lib/supabase/server";
import { clearErrors, recentErrors } from "../../../../instrumentation";

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

  const errors = recentErrors();

  if (new URL(req.url).searchParams.get("clear") === "1") {
    clearErrors();
    return NextResponse.json({ cleared: errors.length });
  }

  return NextResponse.json(
    {
      note:
        errors.length === 0
          ? "Nothing has failed on this server instance since it started. If a screen just broke, reload it once and check again — the retry may land on a different instance."
          : "Newest first. These are the real messages, before production redacts them.",
      count: errors.length,
      errors,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
