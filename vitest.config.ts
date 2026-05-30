import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // TY-270 #19: every test file already imports describe/it/expect/vi from
    // "vitest" explicitly, so `globals: true` only added unused names to the
    // global namespace. Leaving the option off avoids that pollution.
    // Also picks up the staged CLI tests (TY-346); the gh-looppilot extension
    // is developed under cli/ until extracted to its own repo (ADR-0001).
    include: ["tests/**/*.test.ts", "cli/tests/**/*.test.ts"],
  },
});
