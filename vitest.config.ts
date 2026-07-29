import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "db/**/*.test.ts"],
    // Booting a fresh PGlite instance per suite costs a few seconds; the default
    // 5s timeout trips on that before anything is actually wrong.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
