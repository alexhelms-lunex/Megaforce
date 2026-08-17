import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "db/**/*.test.ts"],
    // Booting a fresh PGlite instance per suite costs a few seconds; the default
    // 5s timeout trips on that before anything is actually wrong.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  // Server components are async functions returning JSX. Rendering them in a
  // test is the only way to catch a crash that Next redacts in production, so
  // the suite has to be able to compile TSX.
  // tsconfig.json sets jsx: "preserve" because Next compiles the JSX itself.
  // esbuild reads that and hands Vite raw JSX it cannot parse, so the setting is
  // overridden here for the test run only -- the application build is untouched.
  oxc: {
    jsx: { runtime: "automatic" },
  } as never,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Provided by Next at build time, absent from node_modules. It has no
      // runtime behaviour -- it exists only to fail a build.
      "server-only": path.resolve(__dirname, "./test/server-only.ts"),
    },
  },
});
