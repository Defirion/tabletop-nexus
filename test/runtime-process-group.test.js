import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLocalGameProcessLauncher } from "../src/runtime/process-launcher.js";
import { PrivatePortAllocator } from "../src/runtime/private-ports.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "runtime-game");
const fixtureServer = join(fixtureRoot, "server.mjs");

function fixtureGame(id, args = []) {
  return {
    root: fixtureRoot,
    manifest: {
      id,
      runtime: { command: process.execPath, args: [fixtureServer, ...args] },
    },
  };
}

function linuxProcessIsLive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endName = stat.lastIndexOf(")");
    const state = stat.slice(endName + 2).trim().split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

async function assertPortBindable(host, port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

function createRecordingAllocator({ onFirstRelease } = {}) {
  const allocator = new PrivatePortAllocator();
  const allocations = [];
  const events = [];

  return {
    allocations,
    events,
    allocator: {
      async allocate() {
        const allocationNumber = allocations.length + 1;
        events.push(`allocate:${allocationNumber}`);
        const lease = await allocator.allocate();
        const record = { host: lease.host, port: lease.port, released: false };
        allocations.push(record);
        return Object.freeze({
          host: lease.host,
          port: lease.port,
          release() {
            if (allocationNumber === 1) {
              onFirstRelease?.();
            }
            const released = lease.release();
            if (released) {
              record.released = true;
            }
            events.push(`release:${allocationNumber}:${released}`);
            return released;
          },
        });
      },
    },
  };
}

function createBlockedUnexpectedCleanupLauncher() {
  const realProcessKill = process.kill.bind(process);
  let blocked = true;
  let blockedAttempts = 0;
  return {
    launcher: createLocalGameProcessLauncher({
      processKill(pid, signal) {
        if (pid < 0 && signal === "SIGKILL" && blocked) {
          blockedAttempts += 1;
          const error = new Error("synthetic descendant group kill failure");
          error.code = "EPERM";
          throw error;
        }
        return realProcessKill(pid, signal);
      },
    }),
    allowCleanup() {
      blocked = false;
    },
    get blockedAttempts() {
      return blockedAttempts;
    },
  };
}

async function readRuntimePids(path) {
  const [rootPid, helperPid] = (await readFile(path, "utf8")).trim().split(/\r?\n/).map(Number);
  return { rootPid, helperPid };
}

test("Linux forced switch terminates runtime-owned descendants before lease release", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-group-force-"));
  const pidsFile = join(root, "pids.txt");
  let helperPid;
  let helperLiveAtRelease = null;
  const recording = createRecordingAllocator({
    onFirstRelease() {
      helperLiveAtRelease = linuxProcessIsLive(helperPid);
    },
  });
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 50,
  });

  try {
    await supervisor.start(fixtureGame("group-a", [
      "--helper-listener-root",
      "--ignore-sigterm",
      "--helper-ignore-sigterm",
      `--runtime-pids-file=${pidsFile}`,
    ]));
    ({ helperPid } = await readRuntimePids(pidsFile));
    assert.equal(linuxProcessIsLive(helperPid), true);

    await supervisor.start(fixtureGame("group-b"));

    assert.equal(helperLiveAtRelease, false);
    assert.equal(recording.allocations[0].released, true);
    assert.ok(
      recording.events.indexOf("release:1:true") < recording.events.indexOf("allocate:2"),
      `expected descendant termination/release before replacement allocation, got ${recording.events.join(", ")}`,
    );
    assert.equal(supervisor.getState("group-a").status, "stopped");
    assert.equal(supervisor.getActiveRuntime().gameId, "group-b");
  } finally {
    await supervisor.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux unexpected root exit retains ownership while a descendant survives failed cleanup", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-group-root-exit-"));
  const pidsFile = join(root, "pids.txt");
  const blockedCleanup = createBlockedUnexpectedCleanupLauncher();
  let helperPid;
  let helperLiveAtRelease = null;
  const recording = createRecordingAllocator({
    onFirstRelease() {
      helperLiveAtRelease = linuxProcessIsLive(helperPid);
    },
  });
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    launcher: blockedCleanup.launcher,
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 50,
  });

  try {
    await supervisor.start(fixtureGame("orphan-a", [
      "--helper-listener-root",
      "--helper-ignore-sigterm",
      "--root-exit-after-ms=150",
      `--runtime-pids-file=${pidsFile}`,
    ]));
    const pids = await readRuntimePids(pidsFile);
    helperPid = pids.helperPid;

    await waitUntil(() => blockedCleanup.blockedAttempts > 0);
    assert.equal(linuxProcessIsLive(pids.rootPid), false);
    assert.equal(linuxProcessIsLive(helperPid), true);
    assert.equal(recording.allocations[0].released, false);
    assert.equal(supervisor.getActiveRuntime().gameId, "orphan-a");

    await assert.rejects(
      () => supervisor.start(fixtureGame("orphan-b")),
      /failed to deliver SIGKILL to game process/,
    );
    assert.equal(recording.allocations.length, 1);
    assert.equal(recording.allocations[0].released, false);
    assert.equal(linuxProcessIsLive(helperPid), true);

    blockedCleanup.allowCleanup();
    const recoveredStop = await supervisor.stop();
    assert.equal(recoveredStop.forced, true);
    assert.equal(recording.allocations[0].released, true);
    assert.equal(helperLiveAtRelease, false);
    assert.equal(supervisor.getActiveRuntime(), null);

    await supervisor.start(fixtureGame("orphan-b"));
    assert.ok(
      recording.events.indexOf("release:1:true") < recording.events.indexOf("allocate:2"),
      `expected retained descendant ownership before recovery allocation, got ${recording.events.join(", ")}`,
    );
  } finally {
    blockedCleanup.allowCleanup();
    await supervisor.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux runtime-owned helper exits gracefully with the supervised process group", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-group-graceful-"));
  const pidsFile = join(root, "pids.txt");
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 500,
  });

  try {
    await supervisor.start(fixtureGame("helper-normal", [
      "--helper-listener-root",
      `--runtime-pids-file=${pidsFile}`,
    ]));
    const active = supervisor.getActiveRuntime();
    const { helperPid } = await readRuntimePids(pidsFile);
    assert.equal(linuxProcessIsLive(helperPid), true);

    const stopped = await supervisor.stop();
    assert.equal(stopped.forced, false);
    assert.equal(linuxProcessIsLive(helperPid), false);
    await assertPortBindable(active.host, active.port);
  } finally {
    await supervisor.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
