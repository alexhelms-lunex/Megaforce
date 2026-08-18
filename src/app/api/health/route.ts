import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { tryGetDb, withDeadline } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which of the four things this application depends on are actually answering.
 *
 * ===========================================================================
 * WHY THIS EARNED ITS PLACE
 *
 * Two rounds were spent guessing at a screen that rendered a loading skeleton
 * forever. The first guess -- RingCentral requests with no timeout -- was a real
 * bug, was fixed, and was not the cause. Guessing is expensive and it is
 * expensive in the worst place: somebody redeploys, waits, and reports back
 * that it is still broken.
 *
 * The reason it was hard is that this application talks to Postgres in TWO
 * WAYS, and they fail independently:
 *
 *   Supabase's web API -- every ordinary screen, every list, the sidebar.
 *   A direct Postgres connection -- the phone pipeline, the webhook receiver,
 *     the jobs, and exactly one page.
 *
 * When the direct connection stops answering, the application looks entirely
 * healthy. The sidebar has its badges, every list loads, and the one screen
 * that reads Postgres directly hangs with no error. Nothing on any screen
 * distinguishes that from a slow network.
 *
 * WHY IT IS SAFE TO EXPOSE
 *
 * It is behind SETUP_SECRET, the same key the setup page uses, and it returns
 * only whether each dependency answered and how long it took. No data, no
 * credentials -- not even which credentials exist, which the admin screen does
 * show, because that screen is behind a login and this is not.
 *
 * Every check is deadlined. A health check that can hang is not a health check.
 * ===========================================================================
 */

function keyMatches(presented: string | null): boolean {
  const expected = process.env.SETUP_SECRET;
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

interface Check {
  what: string;
  ok: boolean;
  ms: number;
  detail: string;
}

async function timed(what: string, work: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await work();
    return { what, ok: true, ms: Date.now() - started, detail };
  } catch (err) {
    return {
      what,
      ok: false,
      ms: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET(req: Request) {
  if (!keyMatches(new URL(req.url).searchParams.get("key"))) {
    return Response.json({ error: "Add ?key= and your SETUP_SECRET." }, { status: 403 });
  }

  const checks: Check[] = [];

  // 1. The direct connection. The one that was broken, and the one nothing
  //    else on any screen tells you about.
  checks.push(
    await timed("Postgres, directly (DATABASE_URL)", async () => {
      const db = tryGetDb();
      if (!db) return "DATABASE_URL is not set at all";
      const rows = await withDeadline(db.execute(sql`select 1 as ok`), {
        ms: 8_000,
        label: "Postgres",
      });
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
      return list.length > 0 ? "answered" : "connected but returned nothing";
    }),
  );

  // 2. Whether the database has had the recent changes applied. A deploy ships
  //    code; migrations are applied by visiting the setup page, and the gap
  //    between the two breaks call logging silently.
  checks.push(
    await timed("Database schema is current", async () => {
      const db = tryGetDb();
      if (!db) return "cannot check without a database connection";
      const rows = await withDeadline(
        db.execute(sql`
          select
            (select count(*) from information_schema.tables
              where table_schema = 'public' and table_name = 'live_calls')                as live_calls,
            (select count(*) from information_schema.columns
              where table_schema = 'public' and table_name = 'activities'
                and column_name = 'extension_id')                                          as ext
        `),
        { ms: 8_000, label: "Postgres" },
      );
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? []);
      const row = (list[0] ?? {}) as { live_calls?: number | string; ext?: number | string };
      const missing = [
        Number(row.live_calls ?? 0) > 0 ? null : "live_calls",
        Number(row.ext ?? 0) > 0 ? null : "activities.extension_id",
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new Error(
          `missing ${missing.join(", ")} — open /api/setup?key=… and press "Apply database changes"`,
        );
      }
      return "up to date";
    }),
  );

  // 3. Supabase's web API, which every ordinary screen uses. Checked separately
  //    precisely because it can be healthy while the one above is not.
  checks.push(
    await timed("Supabase web API", async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!url) return "NEXT_PUBLIC_SUPABASE_URL is not set";
      // Either name: the publishable key replaced the anon key, and a
      // deployment configured before that rename still uses the old one.
      const apikey =
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        "";
      const res = await fetch(`${url}/auth/v1/health`, {
        signal: AbortSignal.timeout(8_000),
        headers: { apikey },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      return "answered";
    }),
  );

  // 4. RingCentral, last, because it is the only one the application can run
  //    without.
  checks.push(
    await timed("RingCentral sign-in", async () => {
      const { env } = await import("@/lib/env");
      if (!env.ringCentralConfigured) return "not configured (calls will not be logged)";
      const { rcToken, resetTokenCache } = await import("@/lib/ringcentral/client");
      resetTokenCache();
      await rcToken();
      return "signed in";
    }),
  );

  const ok = checks.every((c) => c.ok);
  return Response.json(
    {
      ok,
      // Ordered as the reader should act on them: the first failure is the one
      // to fix, because the ones after it frequently depend on it.
      firstProblem: checks.find((c) => !c.ok)?.what ?? null,
      checks,
    },
    { status: ok ? 200 : 503 },
  );
}
