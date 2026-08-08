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
};

export default nextConfig;
