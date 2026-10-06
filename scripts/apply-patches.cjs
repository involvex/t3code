/**
 * Applies all patches from the root package.json "patches" field to packages
 * in Bun's .bun cache directory.
 *
 * This is necessary because Bun's patches field support may not work
 * correctly in all versions (particularly canary builds). This script
 * serves as a fallback to ensure patches are applied after `bun install`.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const patches = packageJson.patches || {};
const bunDir = path.join(root, "node_modules/.bun");

if (!fs.existsSync(bunDir)) {
  console.log(".bun cache directory not found, skipping patches");
  process.exit(0);
}

let applied = 0;
let skipped = 0;
let failed = 0;

for (const [pkgName, patchPath] of Object.entries(patches)) {
  const fullPath = path.resolve(root, patchPath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`Patch file not found: ${patchPath} for ${pkgName}`);
    failed++;
    continue;
  }

  // Convert package name to Bun's cache naming convention
  // @scope/name → @scope+name (Bun uses + as separator in cache dir)
  const bunPkgName = pkgName.replace("/", "+");

  // Find matching entries in .bun cache
  // Entries look like: @opencode+protocol@2.0.23 or alchemy@2.0.0-beta.80
  const entries = fs.readdirSync(bunDir).filter((e) => {
    // Match entries that start with the package name + "@"
    // For scoped packages: @opencode+protocol@2.0.23
    // For non-scoped: alchemy@2.0.0-beta.80
    const prefix = bunPkgName + "@";
    return e.startsWith(prefix) || e === bunPkgName;
  });

  // Also check for packages without the + separator in cache name
  // Some packages might be stored as @scope/name@version
  const altEntries = fs.readdirSync(bunDir).filter((e) => {
    const prefix = pkgName + "@";
    return e.startsWith(prefix);
  });

  const allEntries = [...new Set([...entries, ...altEntries])];

  for (const entry of allEntries) {
    const pkgPath = path.join(bunDir, entry, "node_modules", pkgName);
    if (!fs.existsSync(pkgPath)) continue;

    // spawnSync captures stderr on success too: git apply --verbose prints
    // "Skipped patch '<file>'" there while still exiting 0 when hunks don't
    // match (e.g. already fixed by the fallback below). Treat that honestly.
    const result = spawnSync("git", ["apply", "--verbose", fullPath], {
      cwd: pkgPath,
      encoding: "utf8",
    });
    const output = (result.stdout || "") + (result.stderr || "");
    if (result.status === 0 && !output.includes("Skipped patch")) {
      console.log(`✓ Applied patch: ${pkgName} (${entry})`);
      applied++;
    } else if (output.includes("Skipped patch")) {
      console.log(`⊘ Skipped (context mismatch, likely already fixed): ${pkgName}`);
      skipped++;
    } else {
      console.error(`✗ Failed to apply patch: ${pkgName} (${entry})`);
      console.error(output.slice(0, 500));
      failed++;
    }
  }
}

console.log(`\nPatch summary: ${applied} applied, ${skipped} skipped, ${failed} failed`);

// Fallback: direct string replacements for @opencode/* effect/unstable + Encoding
// fixes. Needed because `git apply` fails when a patch was partially applied
// (e.g. manual edit + rerun reports "Skipped patch"), and Bun may ignore the
// root `patches` field on reinstall. This is idempotent — reruns are no-ops.
try {
  require("./fix-opencode-patches.cjs");
} catch (error) {
  console.error("Fallback opencode fix failed:", error.message);
}

// Same story for patches/effect@4.0.1.patch: valid patch, but `git apply`
// skips every hunk inside this repo (exit 0 + "Skipped patch") while applying
// cleanly outside it. Deterministic string replacement instead.
try {
  require("./fix-effect-patch.cjs");
} catch (error) {
  console.error("Fallback effect fix failed:", error.message);
}
