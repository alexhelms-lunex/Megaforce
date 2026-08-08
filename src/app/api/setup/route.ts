import { timingSafeEqual } from "node:crypto";
import { BROWSER_VOLUMES, runSetup, type SetupResult } from "@/lib/setup/run";
import { DEFAULT_VOLUMES } from "../../../../db/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Seeding takes longer than the default allowance. Vercel caps this at the
// plan limit, so on Hobby it lands at 60s -- which is why the browser route
// loads a smaller dataset than the terminal one.
export const maxDuration = 300;

/**
 * One-time setup, for people who would rather not open a terminal.
 *
 * Visiting this URL with the right key builds the tables, loads the sample
 * data, and creates a login -- the same work `npm run setup` does, through the
 * same code, just triggered from a browser.
 *
 * Three things keep a destructive endpoint from being a liability:
 *
 *   1. It does not exist unless SETUP_SECRET is set. No env var, no route --
 *      so a deployment that never opts in cannot be hit at all.
 *   2. The key is compared in constant time. A plain === leaks its length and
 *      then its contents to anyone willing to measure response times.
 *   3. GET only ever renders a confirmation page. The work happens on POST,
 *      behind a button. A link preview, a prefetcher, or a mistyped URL in a
 *      chat window cannot wipe the database by being followed.
 *
 * Delete SETUP_SECRET from the environment once you are done and the route
 * disappears again.
 */

function keyMatches(presented: string | null): boolean {
  const expected = process.env.SETUP_SECRET;
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare a fixed-size digest-shaped pair instead by padding.
  if (a.length !== b.length) {
    // Still burn a comparison so the timing does not distinguish "wrong length"
    // from "wrong contents".
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  if (!process.env.SETUP_SECRET) {
    return html(
      page(
        "Setup is switched off",
        `<p>This page only works when a setup key is configured.</p>
         <p>In Vercel, go to <b>Settings → Environment Variables</b>, add
         <code>SETUP_SECRET</code> with any long random value, redeploy, then visit
         this page again with <code>?key=</code> followed by that value.</p>`,
      ),
      404,
    );
  }

  if (!keyMatches(key)) {
    return html(
      page(
        "Wrong key",
        `<p>Add <code>?key=</code> and your <code>SETUP_SECRET</code> to the end of this
         web address.</p>`,
      ),
      403,
    );
  }

  const full = url.searchParams.get("full") === "1";
  const volumes = full ? DEFAULT_VOLUMES : BROWSER_VOLUMES;

  return html(
    page(
      "Ready to set up your CRM",
      `<p>This will create the tables, load
       <b>${volumes.accounts} companies</b> and
       <b>${volumes.activities.toLocaleString()} calls and emails</b>,
       and make you a login.</p>
       <p class="warn"><b>It erases anything already in this database first.</b>
       That is what you want the first time. It is not what you want if you have
       since put real data in here.</p>
       <form method="post">
         <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
         <input type="hidden" name="full" value="${full ? "1" : "0"}" />
         <button type="submit">Set up my CRM</button>
       </form>
       <p class="dim">Takes about half a minute. Leave this tab open.</p>`,
    ),
  );
}

export async function POST(req: Request) {
  if (!process.env.SETUP_SECRET) return html(page("Setup is switched off", ""), 404);

  const form = await req.formData().catch(() => null);
  const key = form ? String(form.get("key") ?? "") : new URL(req.url).searchParams.get("key");

  if (!keyMatches(key)) return html(page("Wrong key", "<p>That key is not correct.</p>"), 403);

  const full = form ? String(form.get("full") ?? "0") === "1" : false;
  const result = await runSetup({ volumes: full ? DEFAULT_VOLUMES : BROWSER_VOLUMES });

  return html(renderResult(result), result.ok ? 200 : 500);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResult(result: SetupResult): string {
  const steps = result.steps
    .map(
      (s) =>
        `<li class="${s.status}"><span class="mark">${s.status === "ok" ? "✓" : "✗"}</span>
         <b>${escapeHtml(s.name)}</b><span class="dim"> — ${escapeHtml(s.detail)}</span></li>`,
    )
    .join("");

  if (!result.ok) {
    return page(
      "Setup stopped",
      `<ul class="steps">${steps}</ul>
       <div class="problem">
         <h2>${escapeHtml(result.problem?.problem ?? "Something went wrong")}</h2>
         <pre>${escapeHtml(result.problem?.fix ?? "")}</pre>
       </div>
       <p class="dim">Fix that in Vercel under Settings → Environment Variables, redeploy,
       then load this page again. Nothing here is broken permanently.</p>`,
    );
  }

  const tips = result.landmarks?.ambiguousPhone
    ? `<p class="dim">Demo tip: <code>${escapeHtml(result.landmarks.ambiguousPhone)}</code>
       is on file at two different companies. A call from it goes to the review queue
       instead of being filed against the wrong one.</p>`
    : "";

  return page(
    "Your CRM is ready",
    `<ul class="steps">${steps}</ul>
     <div class="login">
       <h2>Sign in with</h2>
       <p><span class="dim">email</span> <code>${escapeHtml(result.login!.email)}</code></p>
       <p><span class="dim">password</span> <code>${escapeHtml(result.login!.password)}</code></p>
       <p class="warn">Write the password down. This page is the only place it is shown.</p>
     </div>
     <p><a class="cta" href="/accounts">Open the CRM →</a></p>
     <p class="dim">${result.stats!.accounts} companies,
       ${result.stats!.contacts} contacts,
       ${result.stats!.activities.toLocaleString()} calls and emails.
       ${result.stats!.qualifyingRate} of that activity counted under the current rules.</p>
     ${tips}
     <p class="dim">Now delete <code>SETUP_SECRET</code> in Vercel → Settings →
     Environment Variables. That switches this page off for good.</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — Megaforce CRM</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --bg:#fff; --line:#e5e5e5;
          --ok:#15803d; --bad:#b91c1c; --warnbg:#fff7ed; --warnline:#fdba74; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#9a9a9a; --bg:#0c0c0c; --line:#262626;
            --ok:#4ade80; --bad:#f87171; --warnbg:#1c1410; --warnline:#7c4a1e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif,
         system-ui, -apple-system, "Segoe UI", sans-serif; padding:3rem 1.25rem; }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size:1.6rem; margin:0 0 1.25rem; letter-spacing:-0.02em; }
  h2 { font-size:1rem; margin:0 0 .5rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em;
         background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.15em .4em;
         border-radius:4px; }
  pre { white-space:pre-wrap; font-family:ui-monospace,Menlo,monospace; font-size:.85rem;
        margin:.5rem 0 0; }
  .dim { color:var(--dim); font-size:.9rem; }
  .steps { list-style:none; padding:0; margin:0 0 1.5rem; }
  .steps li { padding:.5rem 0; border-bottom:1px solid var(--line); }
  .mark { display:inline-block; width:1.25rem; font-weight:700; }
  .ok .mark { color:var(--ok); } .failed .mark { color:var(--bad); }
  .login, .problem { border:1px solid var(--line); border-radius:10px; padding:1rem 1.25rem;
                     margin:1.5rem 0; }
  .problem h2 { color:var(--bad); }
  .warn { background:var(--warnbg); border:1px solid var(--warnline); border-radius:8px;
          padding:.6rem .8rem; font-size:.9rem; }
  button, .cta { display:inline-block; background:var(--fg); color:var(--bg); border:0;
                 border-radius:8px; padding:.7rem 1.2rem; font-size:1rem; font-weight:600;
                 cursor:pointer; text-decoration:none; }
  form { margin:1.25rem 0; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
