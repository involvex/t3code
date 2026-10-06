/**
 * Applies every hunk from the root package.json "patches" field to the
 * matching packages in Bun's .bun cache, by exact content matching.
 *
 * This exists because `git apply` silently skips hunks when run inside this
 * repo (exit 0 + "Skipped patch" on pristine files), while the same patches
 * apply cleanly outside it. Content matching is deterministic and
 * idempotent: reruns are no-ops. Patch files under patches/ remain the
 * single source of truth.
 */
const fs = require("fs");
const path = require("path");

const root = process.env.CONTENT_PATCHES_ROOT ?? path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const patches = packageJson.patches || {};
const bunDir = path.join(root, "node_modules/.bun");

if (!fs.existsSync(bunDir)) {
  console.log("content-patches: .bun cache directory not found, skipping");
  process.exit(0);
}

const storeEntries = fs.readdirSync(bunDir);

let applied = 0;
let skipped = 0;
const failed = [];

function findStoreEntries(pkgName) {
  const bunPkgName = pkgName.replace("/", "+");
  return storeEntries.filter(
    (e) => e === bunPkgName || e.startsWith(bunPkgName + "@") || e.startsWith(pkgName + "@"),
  );
}

function parseDiffBlocks(patchText) {
  const blocks = [];
  let cur = null;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = { from: m[1], to: m[2], deleted: false, hunks: [] };
      blocks.push(cur);
    } else if (cur && line.startsWith("deleted file mode")) {
      cur.deleted = true;
    } else if (cur && line.startsWith("@@ ")) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      cur.hunks.push({ pre: [], post: [], newStart: h ? Number(h[1]) : 0 });
    } else if (
      cur &&
      cur.hunks.length > 0 &&
      !line.startsWith("index ") &&
      !line.startsWith("--- ") &&
      !line.startsWith("+++ ")
    ) {
      const hunk = cur.hunks[cur.hunks.length - 1];
      if (line.startsWith("\\ ")) continue; // "\ No newline at end of file"
      if (line.startsWith("+")) hunk.post.push(line.slice(1));
      else if (line.startsWith("-")) hunk.pre.push(line.slice(1));
      else if (line.startsWith(" ")) {
        hunk.pre.push(line.slice(1));
        hunk.post.push(line.slice(1));
      }
    }
  }
  return blocks;
}

for (const [pkgName, patchPath] of Object.entries(patches)) {
  const fullPath = path.resolve(root, patchPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`content-patches: patch file not found: ${patchPath} for ${pkgName}`);
    failed.push(`${pkgName}: missing patch file`);
    continue;
  }
  const entries = findStoreEntries(pkgName);
  if (entries.length === 0) continue;
  const blocks = parseDiffBlocks(fs.readFileSync(fullPath, "utf8"));

  for (const entry of entries) {
    const pkgPath = path.join(bunDir, entry, "node_modules", pkgName);
    if (!fs.existsSync(pkgPath)) continue;

    for (const block of blocks) {
      const file = path.join(pkgPath, block.to);
      // Patch content is trusted only as far as the target package: refuse
      // hunks that escape it (e.g. a `b/../../` path), since postinstall
      // runs on every contributor and CI machine.
      const relativeTarget = path.relative(pkgPath, file);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        failed.push(`${pkgName} (${entry}): refusing to write outside package dir: ${block.to}`);
        continue;
      }
      if (block.deleted) {
        if (fs.existsSync(file)) {
          fs.rmSync(file);
          console.log(`content-patches: deleted ${pkgName}/${block.to}`);
          applied++;
        } else {
          skipped++;
        }
        continue;
      }
      if (!fs.existsSync(file)) {
        failed.push(`${pkgName} (${entry}): missing target ${block.to}`);
        continue;
      }
      let content = fs.readFileSync(file, "utf8");
      let dirty = false;
      for (const hunk of block.hunks) {
        const pre = hunk.pre.join("\n");
        const post = hunk.post.join("\n");
        if (pre === post) continue;
        if (content.includes(post)) {
          skipped++;
          continue;
        }
        const count = content.split(pre).length - 1;
        if (count === 1) {
          content = content.replace(pre, post);
          dirty = true;
        } else if (count === 0) {
          failed.push(`${pkgName} (${entry}): context mismatch in ${block.to}`);
          break;
        } else {
          // Same context twice (e.g. twin keyboard handlers): apply at the
          // occurrence nearest the hunk's recorded line, like git's anchoring.
          const offsets = [];
          let at = content.indexOf(pre);
          while (at !== -1) {
            offsets.push(at);
            at = content.indexOf(pre, at + 1);
          }
          const lineOf = (o) => content.slice(0, o).split("\n").length;
          offsets.sort(
            (a, b) => Math.abs(lineOf(a) - hunk.newStart) - Math.abs(lineOf(b) - hunk.newStart),
          );
          if (
            offsets.length > 1 &&
            Math.abs(lineOf(offsets[0]) - hunk.newStart) ===
              Math.abs(lineOf(offsets[1]) - hunk.newStart)
          ) {
            failed.push(`${pkgName} (${entry}): ambiguous context (x${count}, tie) in ${block.to}`);
            break;
          }
          const chosen = offsets[0];
          content = content.slice(0, chosen) + post + content.slice(chosen + pre.length);
          console.log(
            `content-patches: positionally applied ${pkgName}/${block.to} (${entry}, line ~${lineOf(chosen)})`,
          );
          dirty = true;
        }
      }
      if (dirty) {
        fs.writeFileSync(file, content, "utf8");
        console.log(`content-patches: patched ${pkgName}/${block.to} (${entry})`);
        applied++;
      }
    }
  }
}

console.log(`\ncontent-patches: ${applied} applied, ${skipped} skipped, ${failed.length} failed`);
for (const f of failed) console.error(`  ✗ ${f}`);
if (failed.length > 0) process.exitCode = 1;
