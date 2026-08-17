import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_CLIENT_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/keys";

/**
 * Keeps the auth session fresh.
 *
 * Supabase access tokens are short-lived. Without a refresh on each navigation
 * a user is signed out mid-session, seemingly at random, and the bug reproduces
 * only after sitting idle for an hour -- which makes it expensive to find.
 *
 * getUser() is called deliberately rather than getSession(): it validates the
 * token against the auth server instead of trusting the cookie, and the cookie
 * is attacker-controllable.
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
   * getUser() is an HTTP call, and supabase-js re-throws network failures
   * instead of returning them. Unguarded, a dropped connection between Vercel
   * and Supabase turned into a 500 for the whole request -- including the POST
   * that carries a server action, so a button press vanished into an error
   * with no message.
   *
   * Failing open is safe here because this check is a convenience, not the
   * security boundary. The layout refuses to render without a profile, and
   * every query underneath it is scoped by row level security inside Postgres,
   * which does not consult this file. The worst case of letting a request
   * through is that somebody signed out sees the layout's own sign-in notice
   * instead of being redirected to it.
   */
  let user: { id: string } | null = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
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

  if (!user && !isPublic) {
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
