/**
 * Applies the hunks from patches/effect@4.0.1.patch via exact string
 * replacement. Needed because `git apply` silently skips every hunk when run
 * inside this repo (exit 0 + "Skipped patch"), while the same patch applies
 * cleanly outside it. Idempotent — reruns are no-ops.
 */
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const bunDir = path.join(root, "node_modules/.bun");

if (!fs.existsSync(bunDir)) {
  console.log("fix-effect-patch: .bun cache not found, skipping");
  process.exit(0);
}

const entries = fs
  .readdirSync(bunDir)
  .filter((e) => e === "effect@4.0.1" || e.startsWith("effect@4.0.1+"));
if (entries.length === 0) {
  console.log("fix-effect-patch: effect@4.0.1 not in .bun cache, skipping");
  process.exit(0);
}

let fixed = 0;

function replaceOnce(pkgDir, relPath, pre, post, label) {
  const file = path.join(pkgDir, relPath);
  if (!fs.existsSync(file)) {
    console.log(`fix-effect-patch: missing ${relPath}, skipping ${label}`);
    return;
  }
  const content = fs.readFileSync(file, "utf8");
  if (content.includes(post)) return; // already applied
  const count = content.split(pre).length - 1;
  if (count !== 1) {
    console.error(
      `fix-effect-patch: expected 1 occurrence for ${label} in ${relPath}, found ${count}`,
    );
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(file, content.replace(pre, post), "utf8");
  console.log(`fix-effect-patch: ${label} (${relPath})`);
  fixed++;
}

for (const entry of entries) {
  const pkgDir = path.join(bunDir, entry, "node_modules", "effect");

  replaceOnce(
    pkgDir,
    "dist/ai/McpServer.js",
    `HttpRouter.add("PATCH", options.path, methodNotAllowed), HttpRouter.add("DELETE", options.path, methodNotAllowed), HttpRouter.add("OPTIONS", options.path, methodNotAllowed)`,
    `HttpRouter.add("PATCH", options.path, methodNotAllowed), HttpRouter.add("OPTIONS", options.path, methodNotAllowed)`,
    "mcp-delete-405",
  );

  replaceOnce(
    pkgDir,
    "dist/ai/McpServer.js",
    `  });\n  return protocol;\n}));\nconst mcpHttpSerialization`,
    `  });\n  yield* router.add("DELETE", options.path, request => {\n    if (!isAllowedMcpOrigin(request, options.allowedOrigins)) {\n      return Effect.succeed(HttpServerResponse.empty({\n        status: 403\n      }));\n    }\n    const sessionId = request.headers[MCP_SESSION_ID_HEADER];\n    return Effect.succeed(HttpServerResponse.empty({\n      status: sessionId === undefined ? 400 : runtime.terminateSession(sessionId) ? 204 : 404\n    }));\n  });\n  return protocol;\n}));\nconst mcpHttpSerialization`,
    "mcp-delete-route",
  );

  replaceOnce(
    pkgDir,
    "dist/ai/internal/mcpRuntime.js",
    `    disconnect: clientId => stateful?.disconnect(clientId),\n    deliveryClientIds:`,
    `    disconnect: clientId => stateful?.disconnect(clientId),\n    terminateSession: sessionId => stateful?.terminateSession(sessionId) ?? false,\n    deliveryClientIds:`,
    "runtime-terminateSession",
  );

  replaceOnce(
    pkgDir,
    "dist/ai/internal/mcpStatefulRuntime.js",
    `    resolveSessionId: sessionId => bySessionId.get(sessionId),\n    setLogLevel:`,
    `    resolveSessionId: sessionId => bySessionId.get(sessionId),\n    terminateSession: sessionId => bySessionId.delete(sessionId),\n    setLogLevel:`,
    "stateful-terminateSession",
  );

  replaceOnce(
    pkgDir,
    "dist/http/HttpClientResponse.js",
    `Cookies.fromSetCookie(this.source.headers.getSetCookie())`,
    `Cookies.fromSetCookie(this.source.headers.getSetCookie?.() ?? [])`,
    "cookies-optional-chain",
  );

  replaceOnce(
    pkgDir,
    "src/http/HttpClientResponse.ts",
    `Cookies.fromSetCookie(this.source.headers.getSetCookie())`,
    `Cookies.fromSetCookie(this.source.headers.getSetCookie?.() ?? [])`,
    "cookies-optional-chain-src",
  );

  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.d.ts",
    `    readonly onDisconnect: Effect.Effect<void>;\n}>;`,
    `    readonly onDisconnect: Effect.Effect<void>;\n    /** Runs when the socket is dropped because pongs stopped, before \`onDisconnect\`. */\n    readonly onPingTimeout?: Effect.Effect<void> | undefined;\n}>;`,
    "rpc-onPingTimeout-type",
  );

  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.js",
    `Effect.flatMap(pinger.timeout, () => Effect.fail(new Socket.SocketError({`,
    `Effect.flatMap(pinger.timeout, () => (Option.isSome(hooks) && hooks.value.onPingTimeout ? hooks.value.onPingTimeout : Effect.void).pipe(Effect.andThen(Effect.fail(new Socket.SocketError({`,
    "rpc-onPingTimeout-hook",
  );

  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.js",
    `cause: new Error("ping timeout")\n      })\n    })))));`,
    `cause: new Error("ping timeout")\n      })\n    })))))));`,
    "rpc-onPingTimeout-close",
  );

  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.js",
    `  let recievedPong = true;\n  const latch = Latch.makeUnsafe();`,
    `  let recievedPong = true;\n  let missedPongs = 0;\n  const latch = Latch.makeUnsafe();`,
    "pinger-missedPongs-state",
  );

  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.js",
    `  const reset = () => {\n    recievedPong = true;\n    latch.closeUnsafe();\n  };`,
    `  const reset = () => {\n    recievedPong = true;\n    missedPongs = 0;\n    latch.closeUnsafe();\n  };`,
    "pinger-reset",
  );

  // `const onPong` also appears in SocketServer; scope it with makePinger's reset.
  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.js",
    `  const onPong = () => {\n    recievedPong = true;\n  };\n  yield* Effect.suspend(() => {`,
    `  const onPong = () => {\n    recievedPong = true;\n    missedPongs = 0;\n  };\n  yield* Effect.suspend(() => {`,
    "pinger-onPong",
  );

  replaceOnce(
    pkgDir,
    "dist/rpc/RpcClient.js",
    `  yield* Effect.suspend(() => {\n    if (!recievedPong) return latch.open;\n    recievedPong = false;\n    return writePing;\n  })`,
    `  yield* Effect.suspend(() => {\n    if (!recievedPong) {\n      missedPongs += 1;\n      if (missedPongs >= 3) return latch.open;\n      return writePing;\n    }\n    recievedPong = false;\n    missedPongs = 0;\n    return writePing;\n  })`,
    "pinger-missedPongs-tolerance",
  );
}

console.log(`fix-effect-patch: ${fixed} replacements applied`);
