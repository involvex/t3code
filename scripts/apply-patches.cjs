/**
 * Postinstall: converges Bun's .bun cache to the patched state declared in
 * the root package.json "patches" field.
 *
 * A git-based step used to live here, but measurements showed it cost ~22s
 * per install while applying nothing: `git apply` silently reports success
 * (exit 0, sometimes with "Skipped patch") on pristine files inside this
 * repo, while the same patches apply cleanly outside it. The content engine
 * below is therefore the sole applier — deterministic and idempotent, with
 * the files under patches/ as the single source of truth.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const bunDir = path.join(root, "node_modules/.bun");

if (!fs.existsSync(bunDir)) {
  console.log(".bun cache directory not found, skipping patches");
  process.exit(0);
}

try {
  require("./apply-content-patches.cjs");
} catch (error) {
  console.error("Content patch application failed:", error.message);
  process.exitCode = 1;
}
