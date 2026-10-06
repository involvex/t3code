const fs = require("fs");
const path = require("path");

const root = process.cwd();
const bunDir = path.join(root, "node_modules/.bun");

let totalFixed = 0;
let encodingFixed = 0;

// Fix all files in @opencode packages
for (const entry of fs.readdirSync(bunDir)) {
  if (!entry.startsWith("@opencode+")) continue;

  // Parse scope from bun cache entry
  // @opencode+protocol@2.0.23 → @opencode/protocol
  // @opencode+client@2.0.23+hash → @opencode/client
  const afterScope = entry.replace(/^@/, "").split("+");
  const scope = "@" + afterScope[0] + "/" + afterScope[1].split("@")[0];

  const nodeModulesDir = path.join(bunDir, entry, "node_modules");
  const pkgPath = path.join(nodeModulesDir, scope);

  if (!fs.existsSync(pkgPath)) {
    // Try finding the package directory
    if (fs.existsSync(nodeModulesDir)) {
      const dirs = fs.readdirSync(nodeModulesDir);
      for (const d of dirs) {
        if (d.startsWith("@opencode")) {
          const fullPath = path.join(nodeModulesDir, d);
          if (fs.statSync(fullPath).isDirectory()) {
            processPackage(fullPath, d, "dist");
          }
        }
      }
    }
    continue;
  }

  processPackage(pkgPath, scope, "dist");
}

function processPackage(pkgPath, pkgName, subdir) {
  const distDir = path.join(pkgPath, subdir);
  if (!fs.existsSync(distDir)) {
    console.log(`${pkgName}: ${subdir} not found`);
    return;
  }

  const filesToFix = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isDirectory()) walk(p);
      else if (item.name.endsWith(".js") || item.name.endsWith(".d.ts")) {
        let content = fs.readFileSync(p, "utf8");
        const original = content;

        // Fix effect/unstable imports
        content = content.replace(/effect\/unstable\/httpapi/g, "effect/http-api");
        content = content.replace(/effect\/unstable\/rpc/g, "effect/rpc");
        content = content.replace(/effect\/unstable\/http/g, "effect/http");
        content = content.replace(/effect\/unstable\/encoding/g, "effect/encoding");

        // Fix Encoding import - remove Encoding from effect import, add Base64Url import
        if (content.includes("Encoding, Result") || content.includes("Encoding } from")) {
          content = content.replace(
            /import \{ ([^}]*) Encoding ([^}]*) \} from "effect";\nimport \{ HttpApiEndpoint/g,
            (match, p1, p2) => {
              const before = p1.replace(/,\s*$/, "");
              const after = p2.replace(/^\s*,/, "").replace(/,\s*$/, "");
              const remaining = [before, after].filter((x) => x.trim()).join(", ");
              return `import { Base64Url } from "effect/encoding";\nimport { ${remaining} } from "effect";\nimport { HttpApiEndpoint`;
            },
          );
          if (content !== original) encodingFixed++;
        }

        // Fix Encoding.encodeBase64Url → Base64Url.encode
        content = content.replace(/Encoding\.encodeBase64Url/g, "Base64Url.encode");
        // Fix Encoding.decodeBase64UrlString → Base64Url.decodeString
        content = content.replace(/Encoding\.decodeBase64UrlString/g, "Base64Url.decodeString");

        // Fix Schema.isStartsWith → Schema.isStartingWith (effect 4.x rename)
        content = content.replace(/Schema\.isStartsWith\(/g, "Schema.isStartingWith(");

        // Fix statics helper: Effect 4.x caches `make` as a non-configurable
        // own property on first read, so Object.assign over a `make` override
        // throws "Attempted to assign to readonly property" at module load.
        content = content.replace(
          `export const statics = (methods) => (schema) => Object.assign(schema, methods(schema));`,
          `export const statics = (methods) => (schema) => {\n    // Effect 4.0.0 caches \`make\` as a non-configurable own property on first\n    // read, so a static that overrides it is defined before anything reads it:\n    // \`methods\` sees a view whose \`make\` comes from a fresh rebuild.\n    const base = schema.rebuild(schema.ast);\n    const view = new Proxy(schema, { get: (target, key) => (key === "make" ? base.make : Reflect.get(target, key)) });\n    for (const [key, value] of Object.entries(methods(view))) {\n        Object.defineProperty(schema, key, { value, writable: true, enumerable: true, configurable: true });\n    }\n    return schema;\n};`,
        );

        if (content !== original) {
          fs.writeFileSync(p, content, "utf8");
          filesToFix.push(path.relative(pkgPath, p));
        }
      }
    }
  }

  walk(distDir);

  if (filesToFix.length > 0) {
    console.log(`${pkgName}: Fixed ${filesToFix.length} files`);
    for (const f of filesToFix) console.log(`  - ${f}`);
    totalFixed += filesToFix.length;
  }
}

console.log(`\nTotal: ${totalFixed} files fixed, ${encodingFixed} Encoding fixes applied`);
