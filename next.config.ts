import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The setup route reads db/migrations/*.sql at runtime.
   *
   * Vercel ships only the files its dependency tracer can see being imported,
   * and a path built at runtime is invisible to that analysis. Without this the
   * route deploys fine and then fails on the one request that matters, with
   * ENOENT on a file that is plainly sitting in the repository.
   */
  outputFileTracingIncludes: {
    "/api/setup": ["./db/migrations/**/*.sql"],
  },

  /**
   * Stamp every build with the commit it came from.
   *
   * ---------------------------------------------------------------------------
   * A server action is addressed by an id baked into the page's JavaScript when
   * it was built. Deploy a new build and those ids change -- so A TAB THAT WAS
   * ALREADY OPEN starts calling ids the server has never heard of. Every button
   * on it fails, and Next reports it with the same redacted sentence it uses
   * for a genuine server crash: "An error occurred in the Server Components
   * render."
   *
   * That is indistinguishable from the application being broken, and it is at
   * its worst during a round of fixes -- each deploy silently breaks the tab
   * being used to test the previous one, so a fix that worked looks like a fix
   * that did nothing.
   *
   * With a deploymentId set, every asset and action request carries which build
   * it came from. Two things follow: Vercel's Skew Protection, if it is turned
   * on for the project, routes those requests to the deployment that can answer
   * them and the problem disappears entirely; and without it, the mismatch is
   * at least visible, which is what run-action.ts checks before blaming the
   * server for something a reload fixes.
   * ---------------------------------------------------------------------------
   */
  deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA,

  experimental: {
    /**
     * How long the browser may reuse a page it has already fetched.
     *
     * -----------------------------------------------------------------------
     * Next 15 ships this at ZERO for dynamic routes, and every page here is
     * dynamic because every page reads rows that depend on who is asking. Zero
     * means the client router keeps nothing: going back, or returning to a tab
     * you were on ten seconds ago, re-runs the whole server render. Alex: "load
     * times are long between pages. how can we make this website feel very
     * responsive."
     *
     * Twenty seconds is chosen to cover the movement people actually complain
     * about -- flicking between Prospects and an account and back, or pressing
     * Back after opening something -- without ever being long enough to show a
     * figure somebody would act on as if it were current.
     *
     * IT IS NOT A CACHE OF WRITES. Every action in this application calls
     * revalidatePath and router.refresh() on success, both of which clear this
     * entirely. So claiming an account, saving a contact or deciding a request
     * shows the new state immediately; only untouched pages are reused.
     *
     * The risk this leaves is narrow and worth naming: somebody else claims an
     * account while you are looking at a stale copy of the pool. That was
     * already true -- the page was rendered at some point in the past either
     * way -- and the claim itself is decided in Postgres, which refuses the
     * second person by name rather than by what their screen said.
     */
    staleTimes: {
      dynamic: 20,
      static: 180,
    },
  },
};

export default nextConfig;
