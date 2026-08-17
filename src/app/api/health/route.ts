import { NextResponse } from "next/server";
import { createClient, loadCurrentUser } from "@/lib/supabase/server";
import { SUPABASE_URL } from "@/lib/supabase/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the time actually goes.
 *
 * ---------------------------------------------------------------------------
 * "The screens are slow" is not something anybody can act on, and guessing at
 * it produces changes that feel like progress and are not. Nearly all of the
 * time in this application is spent waiting for Supabase, so the useful
 * question is a narrow one: how long does ONE round trip take from this server,
 * and how many is a screen making?
 *
 * This times each kind of call separately, from inside the deployment, so the
 * answer includes the network between Vercel and Supabase -- which is the part
 * that varies, and the part that no amount of local testing reveals.
 *
 * The number that matters most is `regionsMatch`. A Vercel deployment in one
 * continent and a Supabase project in another turns every one of these into a
 * transatlantic round trip, and a screen making eight of them is then slow for
 * a reason no code change can fix.
 * ---------------------------------------------------------------------------
 */
export async function GET() {
  const lookup = await loadCurrentUser();
  if (!lookup.user) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const timings: Record<string, number | string> = {};
  const time = async (name: string, run: () => PromiseLike<unknown>) => {
    const started = performance.now();
    try {
      await run();
      timings[name] = Math.round(performance.now() - started);
    } catch (err) {
      timings[name] = `failed after ${Math.round(performance.now() - started)}ms: ${
        (err as Error)?.message ?? String(err)
      }`;
    }
  };

  const supabase = await createClient();

  // Sequentially, deliberately. Run together they would report the latency of
  // the slowest rather than the cost of each, and the cost of each is the
  // thing being measured.
  await time("authRoundTrip", () => supabase.auth.getUser());
  await time("oneRowById", () =>
    supabase.from("users").select("id").eq("id", lookup.user!.id).maybeSingle(),
  );
  await time("accountsPage", () =>
    supabase.from("accounts").select("id, name").limit(50),
  );
  await time("lifecycleView", () =>
    supabase.from("accounts_with_state").select("id, state, days_left").limit(50),
  );
  await time("reportWindow", () =>
    supabase.rpc("report_window", {
      p_from: new Date(Date.now() - 27 * 86_400_000).toISOString().slice(0, 10),
      p_to: new Date().toISOString().slice(0, 10),
      p_scope: "mine",
    }),
  );

  const supabaseRegion = hostRegion(SUPABASE_URL);
  const vercelRegion = process.env.VERCEL_REGION ?? null;

  return NextResponse.json(
    {
      note:
        "Milliseconds per round trip, measured from the server. Anything over about 150ms " +
        "for a single row is network rather than database, and usually means the two halves " +
        "are in different regions.",
      timings,
      where: {
        vercelRegion,
        supabaseHost: safeHost(SUPABASE_URL),
        supabaseRegion,
        regionsMatch:
          vercelRegion && supabaseRegion
            ? sameContinent(vercelRegion, supabaseRegion)
            : "unknown — deploy on Vercel to see this",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Supabase does not publish the region in the URL, so this is a best effort:
 * the project ref tells us nothing, but a self-hosted or pooled host often
 * carries it. Null simply means "could not tell", not "wrong".
 */
function hostRegion(url: string): string | null {
  const host = safeHost(url) ?? "";
  const match = host.match(/\b(us|eu|ap|sa|ca)-(east|west|north|south|central|northeast|southeast)-\d\b/);
  return match ? match[0] : null;
}

function sameContinent(vercel: string, supabase: string): boolean | string {
  const continent = (r: string) => r.slice(0, 2).toLowerCase();
  const a = continent(vercel);
  const b = continent(supabase);
  // Vercel uses iad1/sfo1/fra1/etc rather than AWS names, so only a handful map
  // cleanly. Anything unrecognised says so instead of guessing.
  const vercelContinent: Record<string, string> = {
    ia: "us", cl: "us", pd: "us", sf: "us", // iad1, cle1, pdx1, sfo1
    fr: "eu", du: "eu", lh: "eu", cd: "eu", ar: "eu", // fra1, dub1, lhr1, cdg1, arn1
    hn: "ap", ic: "ap", si: "ap", sy: "ap", bo: "ap", kix: "ap",
    gr: "sa", // gru1
  };
  const mapped = vercelContinent[a];
  if (!mapped) return `unknown Vercel region "${vercel}"`;
  return mapped === b;
}
