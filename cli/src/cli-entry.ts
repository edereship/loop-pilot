#!/usr/bin/env node
/**
 * Executable entry for the bundled CLI (cli.cjs) and `npm run cli`.
 * Kept separate from index.ts so index.ts stays side-effect-free for tests.
 */
import { main } from "./index.js";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
