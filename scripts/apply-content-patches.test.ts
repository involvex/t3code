// @effect-diagnostics nodeBuiltinImport:off - Fixture sandbox shells out to the
// actual postinstall driver so the test covers the shipped code path.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

const driverPath = NodePath.resolve(import.meta.dirname, "apply-content-patches.cjs");

interface Fixture {
  readonly root: string;
  readonly pkgDir: string;
}

function makeFixture(): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "content-patches-"));
  const pkgDir = NodePath.join(
    root,
    "node_modules",
    ".bun",
    "some-pkg@1.0.0",
    "node_modules",
    "some-pkg",
  );
  NodeFS.mkdirSync(pkgDir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "patches"), { recursive: true });
  return { root, pkgDir };
}

function writeManifest(root: string, patches: Record<string, string>): void {
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    JSON.stringify({ name: "fixture", patches }),
  );
}

function runDriver(root: string): { readonly exitCode: number; readonly output: string } {
  try {
    const output = NodeChildProcess.execFileSync(process.execPath, [driverPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CONTENT_PATCHES_ROOT: root },
    });
    return { exitCode: 0, output: String(output) };
  } catch (error) {
    const failure = error as {
      readonly status?: number;
      readonly stdout?: unknown;
      readonly stderr?: unknown;
    };
    return {
      exitCode: failure.status ?? 1,
      output: `${String(failure.stdout ?? "")}${String(failure.stderr ?? "")}`,
    };
  }
}

function removeFixture(root: string): void {
  NodeFS.rmSync(root, { recursive: true, force: true });
}

describe("apply-content-patches", () => {
  it("applies a basic hunk and is a no-op on rerun", () => {
    const { root, pkgDir } = makeFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(pkgDir, "index.js"), "const a = 1;\nconst b = 2;\n");
      writeManifest(root, { "some-pkg": "./patches/some-pkg.patch" });
      NodeFS.writeFileSync(
        NodePath.join(root, "patches", "some-pkg.patch"),
        [
          "diff --git a/index.js b/index.js",
          "--- a/index.js",
          "+++ b/index.js",
          "@@ -1,2 +1,2 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "",
        ].join("\n"),
      );

      const first = runDriver(root);
      assert.strictEqual(first.exitCode, 0);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(pkgDir, "index.js"), "utf8"),
        "const a = 1;\nconst b = 3;\n",
      );

      const second = runDriver(root);
      assert.strictEqual(second.exitCode, 0);
      assert.match(second.output, /0 applied/);
    } finally {
      removeFixture(root);
    }
  });

  it("resolves twin contexts to the occurrence nearest the hunk line", () => {
    const { root, pkgDir } = makeFixture();
    try {
      const twin = ["function first() {", "  const x = compute(1);", "  return x;", "}"].join("\n");
      NodeFS.writeFileSync(NodePath.join(pkgDir, "twin.js"), `${twin}\n\n${twin}\n`);
      writeManifest(root, { "some-pkg": "./patches/twin.patch" });
      NodeFS.writeFileSync(
        NodePath.join(root, "patches", "twin.patch"),
        [
          "diff --git a/twin.js b/twin.js",
          "--- a/twin.js",
          "+++ b/twin.js",
          "@@ -8,3 +8,4 @@",
          "   const x = compute(1);",
          "+  const y = 2;",
          "   return x;",
          " }",
          "",
        ].join("\n"),
      );

      const result = runDriver(root);
      assert.strictEqual(result.exitCode, 0);
      const lines = NodeFS.readFileSync(NodePath.join(pkgDir, "twin.js"), "utf8").split("\n");
      assert.strictEqual(lines[7], "  const y = 2;");
      assert.notStrictEqual(lines[2], "  const y = 2;");
    } finally {
      removeFixture(root);
    }
  });

  it("fails loudly on exact-distance ties instead of guessing", () => {
    const { root, pkgDir } = makeFixture();
    try {
      const twin = ["  const x = compute(1);", "  return x;"].join("\n");
      NodeFS.writeFileSync(NodePath.join(pkgDir, "tie.js"), `${twin}\n${twin}\n`);
      writeManifest(root, { "some-pkg": "./patches/tie.patch" });
      NodeFS.writeFileSync(
        NodePath.join(root, "patches", "tie.patch"),
        [
          "diff --git a/tie.js b/tie.js",
          "--- a/tie.js",
          "+++ b/tie.js",
          "@@ -2,2 +2,3 @@",
          "   const x = compute(1);",
          "+  const y = 2;",
          "   return x;",
          "",
        ].join("\n"),
      );

      const result = runDriver(root);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.output, /tie\.js/);
      assert.notMatch(NodeFS.readFileSync(NodePath.join(pkgDir, "tie.js"), "utf8"), /const y = 2/);
    } finally {
      removeFixture(root);
    }
  });

  it("deletes files for deleted-file blocks", () => {
    const { root, pkgDir } = makeFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(pkgDir, "CHANGELOG.md"), "# log\n");
      writeManifest(root, { "some-pkg": "./patches/delete.patch" });
      NodeFS.writeFileSync(
        NodePath.join(root, "patches", "delete.patch"),
        [
          "diff --git a/CHANGELOG.md b/CHANGELOG.md",
          "deleted file mode 100644",
          "index abc1234..0000000",
          "",
        ].join("\n"),
      );

      const result = runDriver(root);
      assert.strictEqual(result.exitCode, 0);
      assert.isFalse(NodeFS.existsSync(NodePath.join(pkgDir, "CHANGELOG.md")));
    } finally {
      removeFixture(root);
    }
  });

  it("refuses hunks that escape the package directory", () => {
    const { root, pkgDir } = makeFixture();
    try {
      NodeFS.writeFileSync(NodePath.join(pkgDir, "index.js"), "ok\n");
      writeManifest(root, { "some-pkg": "./patches/evil.patch" });
      NodeFS.writeFileSync(
        NodePath.join(root, "patches", "evil.patch"),
        [
          "diff --git a/../../escape.txt b/../../escape.txt",
          "--- a/../../escape.txt",
          "+++ b/../../escape.txt",
          "@@ -0,0 +1,1 @@",
          "+pwned",
          "",
        ].join("\n"),
      );

      const result = runDriver(root);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.output, /outside package dir/);
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "escape.txt")));
    } finally {
      removeFixture(root);
    }
  });
});
