import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createLocalGameProcessLauncher,
  launchGameProcess,
} from "../src/runtime/process-launcher.js";

function installedGame(root, command, args) {
  return { root, manifest: { runtime: { command, args } } };
}

function procStat(pid, processGroup, state = "S") {
  return `${pid} (fixture) ${state} 1 ${processGroup} ${processGroup} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
}

test("Linux local launcher does not bind post-exit ownership to a recycled process-group id", { skip: process.platform !== "linux" }, async () => {
  const controllerPid = 43123;
  const helperPid = 43124;
  const replacementPid = 43125;
  const lifecycleToken = "owned-generation-token";
  const groupCommands = [];
  const spawnCalls = [];
  let generation = "owned";
  let replacementInspections = 0;
  let replacementEnvironmentReads = 0;

  const child = Object.assign(new EventEmitter(), {
    pid: controllerPid,
    exitCode: null,
    signalCode: null,
    connected: true,
    send(message, callback) {
      queueMicrotask(() => {
        callback?.(null);
        if (message.type === "signal") {
          groupCommands.push(message.signal);
          this.emit("message", {
            type: "signal-result",
            requestId: message.requestId,
            ok: true,
          });
          if (message.signal === "SIGKILL") {
            generation = "replacement";
            this.connected = false;
            this.signalCode = "SIGKILL";
            this.emit("close", null, "SIGKILL");
          }
        }
      });
      return true;
    },
  });

  const launcher = createLocalGameProcessLauncher({
    parentEnv: { NEXUS_LIFECYCLE_TOKEN: "stale-parent-token" },
    ownProcessGroup: true,
    createLifecycleToken: () => lifecycleToken,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    readdirProc() {
      if (generation === "replacement") {
        replacementInspections += 1;
        return [String(controllerPid), String(replacementPid)];
      }
      return [String(controllerPid), String(helperPid)];
    },
    readProcFile(path) {
      const match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(path);
      assert.ok(match, `unexpected procfs path ${path}`);
      const pid = Number(match[1]);
      const kind = match[2];
      if (kind === "stat") {
        return procStat(pid, controllerPid);
      }
      if (generation === "owned") {
        return `HOST=127.0.0.1\0NEXUS_LIFECYCLE_TOKEN=${lifecycleToken}\0`;
      }
      replacementEnvironmentReads += 1;
      return "PATH=/usr/bin\0UNRELATED_PROCESS=yes\0";
    },
  });

  const handle = launchGameProcess(
    installedGame("/games/example", "game-server", ["--literal", "a&b"]),
    { launcher, environment: { HOST: "127.0.0.1", NEXUS_LIFECYCLE_TOKEN: "stale-launch-token" } },
  );

  assert.equal(handle, child);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, process.execPath);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  assert.equal(spawnCalls[0].options.env.NEXUS_LIFECYCLE_TOKEN, lifecycleToken);
  const hostedSpec = JSON.parse(spawnCalls[0].args[1]);
  assert.deepEqual(hostedSpec, {
    command: "game-server",
    args: ["--literal", "a&b"],
    cwd: "/games/example",
  });

  child.emit("message", {
    type: "root-exit",
    code: 17,
    signal: null,
    error: null,
  });

  const exit = await launcher.waitForExit(handle);
  assert.deepEqual(exit, { code: 17, signal: null, error: null });
  assert.deepEqual(groupCommands, ["SIGKILL"]);
  assert.ok(replacementInspections > 0, "replacement generation must be observed");
  assert.ok(replacementEnvironmentReads > 0, "replacement generation must be identity-checked");
});
