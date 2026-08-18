import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_CLIENT_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/keys";

/**
 * Keeps the auth session fresh, and sends signed-out visitors to the login page.
 *
 * Supabase access tokens are short-lived. Without a refresh on each navigation
 * a user is signed out mid-session, seemingly at random, and the bug reproduces
 * only after sitting idle for an hour -- which makes it expensive to find.
 *
 * This file is NOT the security boundary and must not be mistaken for one. It
 * decides where to send a browser; row level security in Postgres decides what
 * anybody may read, and the layout refuses to render without a real profile.
 * The comment on the session check below explains what follows from that.
 */
export async function middleware(request: NextRequest) {
  // Without credentials there is no session to refresh, and the app renders a
  // setup screen instead of crashing on every request.
  if (!isSupabaseConfigured()) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_CLIENT_KEY, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  /*
   * Guarded, and it fails OPEN rather than closed.
   *
   * These are HTTP calls, and supabase-js re-throws network failures instead of
   * returning them. Unguarded, a dropped connection between Vercel and Supabase
   * turned into a 500 for the whole request -- including the POST that carries
   * a server action, so a button press vanished into an error with no message.
   *
   * Failing open is safe here because this check is a convenience, not the
   * security boundary. The layout refuses to render without a profile, and
   * every query underneath it is scoped by row level security inside Postgres,
   * which does not consult this file. The worst case of letting a request
   * through is that somebody signed out sees the layout's own sign-in notice
   * instead of being redirected to it.
   */

  /*
   * WHY getSession() FIRST, AND getUser() ONLY AS A FALLBACK
   *
   * This used to call getUser() unconditionally. getUser() asks the Supabase
   * auth server to validate the token -- a real network round trip, on EVERY
   * request this matcher covers, before Next has even begun rendering. Measured
   * at about forty milliseconds against the production project, and it is
   * serial: nothing else starts until it comes back. Alex, twice: "Response
   * times switching tabs ... are super slow" and "load times are long between
   * pages."
   *
   * getSession() reads the cookie and only reaches the network when the token
   * actually needs refreshing, which is once an hour rather than once a click.
   * So the common case -- a valid, unexpired session -- becomes free.
   *
   * The usual objection to getSession() in middleware is that a cookie is
   * attacker-controllable, so session.user cannot be trusted. That is true and
   * it is why session.user is NOT read here. The only question this file asks
   * is "is there a session at all", and the only thing it does with the answer
   * is decide whether to redirect to the login page. A forged cookie buys
   * exactly one thing: not being redirected. The layout then calls getUser()
   * for real, finds nothing, and shows the sign-in notice -- and every query
   * beneath it is refused by row level security in Postgres, which has never
   * heard of this file.
   *
   * When there is NO session, getUser() runs after all. Wrongly bouncing
   * somebody to /login mid-session is the failure people notice and cannot
   * explain, so it is worth one round trip to be sure before doing it.
   */
  let hasSession = false;
  try {
    const { data } = await supabase.auth.getSession();
    hasSession = data.session !== null;

    if (!hasSession) {
      const result = await supabase.auth.getUser();
      hasSession = result.data.user !== null;
    }
  } catch (err) {
    console.error("[middleware] could not verify the session", err);
    return response;
  }

  const path = request.nextUrl.pathname;
  const isPublic =
    path === "/login" ||
    // The password reset flow, all of which happens WITHOUT a session -- and
    // /auth/callback is the route that creates one, so bouncing it to /login
    // would make every reset email dead on arrival.
    path === "/forgot-password" ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/webhooks") ||
    path.startsWith("/api/inngest") ||
    // Setup has to be reachable before any login exists -- it is the thing that
    // creates the first one. Redirecting it to /login would make the app
    // impossible to set up. It has its own key check.
    path.startsWith("/api/setup");

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
