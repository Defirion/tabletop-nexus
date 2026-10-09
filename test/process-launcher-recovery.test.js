import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createLocalGameProcessLauncher, launchGameProcess } from "../src/runtime/process-launcher.js";

const linuxOnly = { skip: process.platform !== "linux" };

const CONTROLLER = 52100;
const HELPER = 52101;
const TOKEN = "recorded-generation-token";
const record = Object.freeze({
  kind: "linux-process-group",
  lifecycleToken: TOKEN,
  processGroupId: CONTROLLER,
  controllerPid: CONTROLLER,
});

function procStat(pid, processGroup, state = "S") {
  return `${pid} (fixture) ${state} 1 ${processGroup} ${processGroup} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
}

/** A fake /proc: `processes` maps pid -> { group, token, state }. */
function launcherOver(processes, { failOn = null } = {}) {
  const kills = [];
  const launcher = createLocalGameProcessLauncher({
    ownProcessGroup: true,
    processKill(...args) {
      kills.push(args);
    },
    readdirProc: () => Object.keys(processes),
    readProcFile(path) {
      const [, pid, kind] = /^\/proc\/(\d+)\/(stat|environ)$/.exec(path);
      if (failOn?.pid === Number(pid) && failOn.kind === kind) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      const process_ = processes[pid];
      if (process_ === undefined) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return kind === "stat"
        ? procStat(Number(pid), process_.group, process_.state)
        : `HOST=127.0.0.1\0${process_.token === undefined ? "X=1" : `NEXUS_LIFECYCLE_TOKEN=${process_.token}`}\0`;
    },
  });
  return { launcher, kills };
}

test("recovery reports a recorded generation absent when nothing carries its token", linuxOnly, () => {
  const { launcher, kills } = launcherOver({
    // A different process now reuses the recorded group number but not its token.
    [CONTROLLER]: { group: CONTROLLER, token: "someone-elses-token", state: "S" },
    [HELPER]: { group: CONTROLLER },
    9999: { group: 9999, token: TOKEN },
  });
  assert.deepEqual(launcher.inspectRecovery(record), { state: "absent" });
  assert.deepEqual(kills, [], "inspection never signals");
});

test("recovery reports a live controller and members as present with a controller", linuxOnly, () => {
  const { launcher, kills } = launcherOver({
    [CONTROLLER]: { group: CONTROLLER, token: TOKEN, state: "S" },
    [HELPER]: { group: CONTROLLER, token: TOKEN, state: "S" },
  });
  assert.deepEqual(launcher.inspectRecovery(record), { state: "present", controllerLive: true });
  assert.deepEqual(kills, []);
});

test("recovery reports members without their controller so nothing outside can safely signal them", linuxOnly, () => {
  const { launcher, kills } = launcherOver({
    [HELPER]: { group: CONTROLLER, token: TOKEN, state: "S" },
  });
  assert.deepEqual(launcher.inspectRecovery(record), { state: "present", controllerLive: false });
  assert.deepEqual(kills, []);
});

test("recovery ignores zombies", linuxOnly, () => {
  const { launcher } = launcherOver({
    [CONTROLLER]: { group: CONTROLLER, token: TOKEN, state: "Z" },
    [HELPER]: { group: CONTROLLER, token: TOKEN, state: "X" },
  });
  assert.deepEqual(launcher.inspectRecovery(record), { state: "absent" });
});

test("recovery treats procfs inspection failures as ambiguous, never as absent", linuxOnly, () => {
  const { launcher } = launcherOver(
    { [HELPER]: { group: CONTROLLER, token: TOKEN } },
    { failOn: { pid: HELPER, kind: "environ" } },
  );
  const result = launcher.inspectRecovery(record);
  assert.equal(result.state, "ambiguous");
  assert.match(result.detail, /failed to inspect game process group/);
});

test("recovery rejects unsupported or malformed records as ambiguous", linuxOnly, () => {
  const { launcher, kills } = launcherOver({});
  for (const bad of [
    null,
    {},
    { ...record, kind: "something-else" },
    { ...record, lifecycleToken: "" },
    { ...record, processGroupId: 1 },
    { ...record, processGroupId: "4242" },
    { ...record, controllerPid: record.controllerPid + 1 },
  ]) {
    assert.equal(launcher.inspectRecovery(bad).state, "ambiguous", JSON.stringify(bad));
  }
  assert.deepEqual(kills, []);
});

test("a launcher without its own process group cannot verify a leftover and says so", () => {
  const launcher = createLocalGameProcessLauncher({ ownProcessGroup: false });
  assert.equal(launcher.recoverable, false);
  assert.equal(launcher.inspectRecovery(record).state, "ambiguous");
});

function hostedLauncher({ events }) {
  const child = Object.assign(new EventEmitter(), {
    pid: CONTROLLER,
    exitCode: null,
    signalCode: null,
    connected: true,
    send(message, callback) {
      events.push(`send:${message.type}`);
      queueMicrotask(() => callback?.(null));
      return true;
    },
    disconnect() {
      events.push("disconnect");
    },
  });
  return createLocalGameProcessLauncher({
    ownProcessGroup: true,
    createLifecycleToken: () => TOKEN,
    spawn: () => child,
    readdirProc: () => [],
    readProcFile: () => "",
  });
}

const game = { root: "/games/example", manifest: { runtime: { command: "game-server", args: [] } } };

test("the runtime is only started after its ownership has been recorded", () => {
  const events = [];
  const launcher = hostedLauncher({ events });
  launchGameProcess(game, {
    launcher,
    recordOwnership(ownership) {
      events.push("record");
      assert.deepEqual(ownership, record);
    },
  });
  assert.deepEqual(events, ["record", "send:start"]);
});

test("a launch whose ownership cannot be recorded never starts the runtime", () => {
  const events = [];
  const launcher = hostedLauncher({ events });
  assert.throws(
    () => launchGameProcess(game, {
      launcher,
      recordOwnership() {
        throw new Error("journal unavailable");
      },
    }),
    /journal unavailable/,
  );
  assert.deepEqual(events, ["disconnect"], "the empty controller is released without a start message");
});

test("launching without a recorder still starts the runtime", () => {
  const events = [];
  launchGameProcess(game, { launcher: hostedLauncher({ events }) });
  assert.deepEqual(events, ["send:start"]);
});
