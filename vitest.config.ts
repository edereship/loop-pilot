import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // TY-270 #19: every test file already imports describe/it/expect/vi from
    // "vitest" explicitly, so `globals: true` only added unused names to the
    // global namespace. Leaving the option off avoids that pollution.
    include: ["tests/**/*.test.ts"],
  },
});
