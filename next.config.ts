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
};

export default nextConfig;
