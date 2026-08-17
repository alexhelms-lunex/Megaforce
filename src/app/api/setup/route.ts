import { timingSafeEqual } from "node:crypto";
import {
  ADMIN_EMAIL,
  BROWSER_VOLUMES,
  fetchAuthLogins,
  runLinkOnly,
  runMigrationsOnly,
  runPasswordReset,
  runSetup,
  type SetupResult,
} from "@/lib/setup/run";
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

  // Rescue path. Supabase's login service is a separate host from the database,
  // so it can be unreachable while everything else has already succeeded. This
  // mode attaches a login created by hand in the dashboard, using only the
  // database connection that has already proven it works.
  if (url.searchParams.get("link") === "1") {
    // Offer the logins that actually exist rather than demanding a specific
    // address. Whichever email was used in the dashboard is the right one; a
    // placeholder invented by a seed script is not something to have to match.
    const { logins, error } = await fetchAuthLogins();

    // The paste-the-UID form is ALWAYS offered, because it is the one that
    // cannot be refused. Supabase keeps auth.users under a schema owned by its
    // own role, and a project may not grant our role read access -- so the
    // dropdown below can come back empty while the login plainly exists in the
    // dashboard. Writing our own table never needs anyone's permission.
    const manual = `
      <form method="post">
        <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
        <input type="hidden" name="link" value="1" />
        <label for="authId">User UID</label>
        <input id="authId" name="authId" placeholder="52a67572-7bce-405d-93a3-77b8601ffc8d"
               autocomplete="off" spellcheck="false" />
        <label for="manualEmail">Email on that login <span class="dim">(optional)</span></label>
        <input id="manualEmail" name="email" type="email"
               placeholder="you@megaforce.test" autocomplete="off" />
        <button type="submit">Connect it</button>
      </form>
      <p class="dim">Find the UID in Supabase under <b>Authentication → Users</b>, in the
      <b>UID</b> column beside your login. Copy the whole thing.</p>`;

    if (logins.length > 0) {
      const options = logins
        .map((l) => `<option value="${escapeHtml(l.email)}">${escapeHtml(l.email)}</option>`)
        .join("");

      return html(
        page(
          "Connect your login",
          `<p>This does not touch your data. It connects a Supabase login to the CRM's
           admin profile so you can sign in.</p>
           <form method="post">
             <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
             <input type="hidden" name="link" value="1" />
             <label for="email">Which login is yours?</label>
             <select id="email" name="email">${options}</select>
             <button type="submit">Connect it</button>
           </form>
           <hr />
           <h2>Or paste the ID yourself</h2>
           ${manual}`,
        ),
      );
    }

    // Nothing listed. Say honestly which of the two reasons applies.
    const why = error
      ? `<p class="warn">Could not read the list of logins from this project. That does
         <b>not</b> mean you have none — Supabase often withholds that table from the
         app's database role. Paste the ID below instead and it will work.</p>
         <pre class="dim">${escapeHtml(error)}</pre>`
      : `<p>No logins turned up. If you have not made one yet, it takes about thirty
         seconds:</p>
         <ol>
           <li>In Supabase: <b>Authentication → Users → Add user → Create new user</b></li>
           <li>Email: anything you like</li>
           <li>Password: anything. <b>Write it down.</b></li>
           <li>Tick <b>Auto Confirm User</b>, then create it</li>
         </ol>`;

    return html(page("Connect your login", `${why}<h2>Paste the ID</h2>${manual}`));
  }

  /*
   * Two buttons, and the safe one is first.
   *
   * There used to be only the destructive one, which meant picking up a schema
   * change cost somebody every account, person and setting they had made. That
   * is a bad trade at any time and a circular one during a round of fixes --
   * the next round then gets tested against a different database than the one
   * that had the problem.
   */
  /*
   * Forgotten password.
   *
   * The password is shown once and never again, which is right for a password
   * and a dead end for anybody who closes the tab. The only way out used to be
   * the Supabase dashboard -- a tool this application otherwise never asks
   * anybody to open.
   */
  if (url.searchParams.get("password") === "1") {
    const { logins, error } = await fetchAuthLogins();

    const manual = `
      <form method="post">
        <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
        <input type="hidden" name="password" value="1" />
        <label for="authId">User UID</label>
        <input id="authId" name="authId" placeholder="52a67572-7bce-405d-93a3-77b8601ffc8d"
               autocomplete="off" spellcheck="false" />
        <button type="submit">Give me a new password</button>
      </form>
      <p class="dim">Find the UID in Supabase under <b>Authentication → Users</b>, in the
      <b>UID</b> column beside your login.</p>`;

    if (logins.length > 0) {
      const options = logins
        .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.email)}</option>`)
        .join("");
      return html(
        page(
          "New password",
          `<p>This sets a new password on a login that already exists. It does not touch
           your data, and it does not change which login is yours.</p>
           <form method="post">
             <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
             <input type="hidden" name="password" value="1" />
             <label for="authId">Which login?</label>
             <select id="authId" name="authId">${options}</select>
             <button type="submit">Give me a new password</button>
           </form>
           <hr />
           <h2>Or paste the ID yourself</h2>
           ${manual}`,
        ),
      );
    }

    const why = error
      ? `<p class="warn">Could not list the logins on this project. That does <b>not</b>
         mean you have none — Supabase often withholds that table from the app's
         database role. Paste the ID below instead.</p>
         <pre class="dim">${escapeHtml(error)}</pre>`
      : `<p>No logins turned up on this project.</p>`;

    return html(page("New password", `${why}<h2>Paste the ID</h2>${manual}`));
  }

  return html(
    page(
      "Set up or update your CRM",
      `<div class="login">
         <h2>Just apply the database changes</h2>
         <p>Use this when a new version needs a database change. It adds whatever is
         missing and <b>leaves every company, person and setting exactly as it is</b>.
         Safe to press twice.</p>
         <form method="post">
           <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
           <input type="hidden" name="migrate" value="1" />
           <button type="submit">Apply database changes</button>
         </form>
       </div>
       <hr />
       <h2>Or start over from scratch</h2>
       <p>This will create the tables, load
       <b>${volumes.accounts} companies</b> and
       <b>${volumes.activities.toLocaleString()} calls and emails</b>,
       and make you a login.</p>
       <p class="warn"><b>It erases everything already in this database first.</b>
       That is what you want the first time, and only the first time.</p>
       <form method="post">
         <input type="hidden" name="key" value="${escapeHtml(key ?? "")}" />
         <input type="hidden" name="full" value="${full ? "1" : "0"}" />
         <button type="submit">Erase and start over</button>
       </form>
       <p class="dim">Takes about half a minute. Leave this tab open.</p>
       <hr />
       <p class="dim">Forgotten the password to a login that already exists?
       <a href="?key=${encodeURIComponent(key ?? "")}&amp;password=1">Get a new one</a> —
       it does not touch your data.</p>`,
    ),
  );
}

export async function POST(req: Request) {
  if (!process.env.SETUP_SECRET) return html(page("Setup is switched off", ""), 404);

  const form = await req.formData().catch(() => null);
  const key = form ? String(form.get("key") ?? "") : new URL(req.url).searchParams.get("key");

  if (!keyMatches(key)) return html(page("Wrong key", "<p>That key is not correct.</p>"), 403);

  if (form && String(form.get("link") ?? "") === "1") {
    const authId = String(form.get("authId") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const linked = await runLinkOnly({
      authId: authId || undefined,
      email: email || (authId ? undefined : ADMIN_EMAIL),
    });
    return html(renderResult(linked), linked.ok ? 200 : 500);
  }

  if (form && String(form.get("password") ?? "") === "1") {
    const reset = await runPasswordReset(String(form.get("authId") ?? ""));
    return html(renderResult(reset), reset.ok ? 200 : 500);
  }

  if (form && String(form.get("migrate") ?? "") === "1") {
    const migrated = await runMigrationsOnly();
    return html(renderResult(migrated), migrated.ok ? 200 : 500);
  }

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

  if (result.passwordOnly) {
    return page(
      "New password",
      `<ul class="steps">${steps}</ul>
       <div class="login">
         <h2>Sign in with</h2>
         <p><span class="dim">email</span> <code>${escapeHtml(result.login!.email)}</code></p>
         <p><span class="dim">password</span> <code>${escapeHtml(result.login!.password)}</code></p>
         <p class="warn">Write it down. This page is the only place it is shown.</p>
       </div>
       <p>Nothing in your data was changed.</p>
       <p><a class="cta" href="/login">Sign in →</a></p>`,
    );
  }

  if (result.migrationsOnly) {
    return page(
      "Database is up to date",
      `<ul class="steps">${steps}</ul>
       <p>Nothing in your data was changed. Every company, person and setting is as
       you left it.</p>
       <p class="warn">Close any CRM tab you already had open and open a fresh one —
       an old tab is still wired to the previous version.</p>
       <p><a class="cta" href="/">Open the CRM →</a></p>`,
    );
  }

  const tips = result.landmarks?.ambiguousPhone
    ? `<p class="dim">Demo tip: <code>${escapeHtml(result.landmarks.ambiguousPhone)}</code>
       is on file at two different companies. A call from it goes to the review queue
       instead of being filed against the wrong one.</p>`
    : "";

  const stats = result.stats
    ? `<p class="dim">${result.stats.accounts} companies,
       ${result.stats.contacts} contacts,
       ${result.stats.activities.toLocaleString()} calls and emails.
       ${result.stats.qualifyingRate} of that activity counted under the current rules.</p>`
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
     ${stats}
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@700&display=swap">
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --bg:#fff; --line:#e5e5e5;
          --ok:#15803d; --bad:#b91c1c; --warnbg:#fff7ed; --warnline:#fdba74; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#9a9a9a; --bg:#0c0c0c; --line:#262626;
            --ok:#4ade80; --bad:#f87171; --warnbg:#1c1410; --warnline:#7c4a1e; }
  }
  * { box-sizing: border-box; }
  /* The house faces, named the same way the application names them. This page
     is plain HTML served from an API route rather than a React screen, so it
     misses the app stylesheet entirely -- which is why it was still rendering
     in Segoe UI after the typeface change and read as "the old font is still
     visible in some places". */
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 Inter,
         ui-sans-serif, system-ui, -apple-system, sans-serif; padding:3rem 1.25rem; }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size:1.6rem; margin:0 0 1.25rem; letter-spacing:-0.02em;
       font-family:"JetBrains Mono", ui-monospace, monospace; font-weight:700; }
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
  label { display:block; font-weight:600; margin-bottom:.4rem; }
  select, input[type=text], input[type=email], input:not([type]) {
           display:block; width:100%; max-width:30rem; margin-bottom:1rem; padding:.6rem .7rem;
           font-size:1rem; border-radius:8px; border:1px solid var(--line);
           background:var(--bg); color:var(--fg); font-family:inherit; }
  input#authId { font-family: ui-monospace, Menlo, monospace; font-size:.95rem; }
  hr { border:0; border-top:1px solid var(--line); margin:2rem 0 1.25rem; }
  ol { padding-left:1.2rem; } ol li { margin:.35rem 0; }
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
