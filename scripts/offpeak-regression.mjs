#!/usr/bin/env node
/**
 * Regression guard: opencode-offpeak's own test suite must keep passing after
 * opencode-free-first is installed. The plugin is never modified by this
 * repository; this script only runs the neighbour's checks and reports the
 * result, failing loudly if the neighbour checkout is missing.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const checkout = process.env.OFFPEAK_CHECKOUT ?? path.resolve(process.cwd(), "..", "opencode-offpeak");
if (!existsSync(path.join(checkout, "package.json"))) {
  console.error(`opencode-offpeak checkout not found at ${checkout}`);
  console.error("Set OFFPEAK_CHECKOUT to the neighbour repository and retry.");
  process.exit(2);
}

for (const script of ["lint", "typecheck", "test"]) {
  process.stdout.write(`\n=== opencode-offpeak npm run ${script} ===\n`);
  const result = spawnSync("npm", ["run", script], { cwd: checkout, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`opencode-offpeak ${script} failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
console.log("\nopencode-offpeak regression suite passed unchanged.");
