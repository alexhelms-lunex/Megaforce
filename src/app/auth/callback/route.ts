import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a link in an email lands.
 *
 * ---------------------------------------------------------------------------
 * A recovery link does not carry a session. It carries a ONE-TIME CODE, and
 * that code has to be exchanged for a session on the server before anything is
 * rendered. This is the route that does the exchange, and it is a route handler
 * rather than a page because it has to set cookies -- which a page render
 * cannot do.
 *
 * Two shapes arrive here, and both are supported because which one you get
 * depends on a setting inside Supabase rather than on anything in this code:
 *
 *   ?code=...                    the PKCE flow, exchanged for a session
 *   ?token_hash=...&type=recovery  the OTP flow, verified instead
 *
 * `next` decides where they land afterwards, and it is deliberately restricted
 * to a path on this site. Reflecting an arbitrary URL from a query string into
 * a redirect is an open redirect, and an open redirect on the page somebody
 * arrives at from an email is exactly the one worth having.
 * ---------------------------------------------------------------------------
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  // Only a same-site path, never a full URL, and never a protocol-relative one
  // -- "//evil.example" is a valid absolute URL to a browser.
  const requested = url.searchParams.get("next") ?? "/reset-password";
  const next = /^\/(?!\/)/.test(requested) ? requested : "/reset-password";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason(error.message))}`, url.origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "recovery" | "email" | "invite" | "magiclink",
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason(error.message))}`, url.origin));
  }

  return NextResponse.redirect(
    new URL(
      `/login?error=${encodeURIComponent("That link is missing its code. Ask for a new one.")}`,
      url.origin,
    ),
  );
}

/**
 * An expired link is the common case, and it deserves its own sentence.
 *
 * Recovery links last an hour and work once. Somebody who clicks yesterday's
 * email, or clicks the same one twice, gets a failure that reads like the
 * system is broken unless it says which of those happened.
 */
function reason(message: string): string {
  if (/expired|invalid|not found|already/i.test(message)) {
    return "That reset link has expired or has already been used. Ask for a new one.";
  }
  return message;
}
