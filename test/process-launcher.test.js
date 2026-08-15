import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  GAME_LAUNCH_SECURITY_BOUNDARY,
  createLocalGameProcessLauncher,
  launchGameProcess,
  launchLocalGameProcess,
} from "../src/runtime/process-launcher.js";

function installedGame(root, command, args) {
  return { root, manifest: { runtime: { command, args } } };
}

function collectChild(child) {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`child exited with code ${code} signal ${signal ?? "none"}: ${stderr}`));
        return;
      }
      resolveResult({ stdout, stderr });
    });
  });
}

test("launchLocalGameProcess keeps executable, arguments, environment, and shell boundary separate", () => {
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null });
  const game = installedGame(
    "/games/example",
    "game-server; unexpected-shell-command",
    ["--label", "$(whoami)", "a&b", "pipe|value"],
  );

  const result = launchLocalGameProcess(game, {
    parentEnv: { KEEP: "yes", HOST: "wrong" },
    environment: { HOST: "127.0.0.1", PORT: "43123", BASE_PATH: "/games/example" },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result, child);
  assert.deepEqual(calls, [{
    command: "game-server; unexpected-shell-command",
    args: ["--label", "$(whoami)", "a&b", "pipe|value"],
    options: {
      cwd: "/games/example",
      shell: false,
      env: {
        KEEP: "yes",
        HOST: "127.0.0.1",
        PORT: "43123",
        BASE_PATH: "/games/example",
      },
    },
  }]);
});

test("launchLocalGameProcess treats shell metacharacters literally and runs from the game root", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-launch-"));
  const literalArgs = ["semi;colon", "$(substitution)", "a&b", "pipe|value", ">redirect", "%PATH%"];

  try {
    await writeFile(join(root, "marker.txt"), "cwd-ok", "utf8");
    const script = [
      'const { readFileSync } = require("node:fs");',
      "process.stdout.write(JSON.stringify({",
      "  cwd: process.cwd(),",
      '  marker: readFileSync("marker.txt", "utf8"),',
      "  args: process.argv.slice(1),",
      "}));",
    ].join("\n");

    const child = launchLocalGameProcess(installedGame(root, process.execPath, ["-e", script, ...literalArgs]));
    const { stdout, stderr } = await collectChild(child);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      cwd: resolve(root),
      marker: "cwd-ok",
      args: literalArgs,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchLocalGameProcess rejects a malformed argument vector before spawning", () => {
  let called = false;
  const game = installedGame("/games/example", "node", "--version");
  assert.throws(
    () => launchLocalGameProcess(game, { parentEnv: {}, spawn: () => { called = true; } }),
    /runtime\.args must be an array of strings/,
  );
  assert.equal(called, false);
});

test("launchGameProcess delegates an immutable launch spec to an isolated launcher", () => {
  const game = installedGame("/games/example", "node", ["server.js", "--mode", "table"]);
  const opaqueHandle = Object.freeze({ unit: "tabletop-nexus-game@example.service" });
  const environment = { HOST: "127.0.0.1", PORT: "4444", BASE_PATH: "/games/example" };
  let receivedSpec;

  const result = launchGameProcess(game, {
    environment,
    requireDistinctSecurityBoundary: true,
    launcher: {
      securityBoundary: GAME_LAUNCH_SECURITY_BOUNDARY.DISTINCT_SECURITY_BOUNDARY,
      launch(spec) {
        receivedSpec = spec;
        assert.equal(Object.isFrozen(spec), true);
        assert.equal(Object.isFrozen(spec.args), true);
        assert.equal(Object.isFrozen(spec.environment), true);
        return opaqueHandle;
      },
    },
  });

  environment.PORT = "9999";
  game.manifest.runtime.args.push("--later");
  assert.equal(result, opaqueHandle);
  assert.deepEqual(receivedSpec, {
    command: "node",
    args: ["server.js", "--mode", "table"],
    cwd: "/games/example",
    environment: { HOST: "127.0.0.1", PORT: "4444", BASE_PATH: "/games/example" },
  });
});

test("launchGameProcess fails closed before a same-identity launcher runs when isolation is required", () => {
  let launched = false;
  const launcher = createLocalGameProcessLauncher({
    parentEnv: {},
    spawn() {
      launched = true;
      return { pid: 1234 };
    },
  });

  assert.throws(
    () => launchGameProcess(installedGame("/games/example", "node", ["server.js"]), {
      launcher,
      requireDistinctSecurityBoundary: true,
    }),
    /requires a distinct security identity or sandbox boundary/,
  );
  assert.equal(launched, false);
});

test("launchGameProcess rejects an undeclared launcher boundary before launch", () => {
  let launched = false;
  assert.throws(
    () => launchGameProcess(installedGame("/games/example", "node", ["server.js"]), {
      launcher: {
        securityBoundary: "probably-isolated",
        launch() { launched = true; },
      },
    }),
    /securityBoundary must declare a supported game launch boundary/,
  );
  assert.equal(launched, false);
});
