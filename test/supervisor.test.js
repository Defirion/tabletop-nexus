import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      schema: 2,
      id,
      name: id,
      players: { min: 1, max: 4 },
      capabilities: { tvLess: true },
      runtime: {
        command: process.execPath,
        args: [fixtureServer, ...args],
      },
    },
  };
}

async function assertPortBindable(host, port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

function createRecordingAllocator() {
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

function createFirstProcessSignalFailureLauncher() {
  let spawnCount = 0;
  let firstPid = null;
  let allowFirstTermination = false;
  const realProcessKill = process.kill.bind(process);
  const launcher = createLocalGameProcessLauncher({
    processKill(pid, signal) {
      if (
        process.platform !== "win32" &&
        firstPid !== null &&
        pid === -firstPid &&
        !allowFirstTermination
      ) {
        const error = new Error(`synthetic ${signal} delivery failure`);
        error.code = "EPERM";
        throw error;
      }
      return realProcessKill(pid, signal);
    },
    spawn(command, args, options) {
      const child = nodeSpawn(command, args, options);
      spawnCount += 1;
      if (spawnCount === 1) {
        firstPid = child.pid;
        if (process.platform === "win32") {
          const realKill = child.kill.bind(child);
          child.kill = (signal) => {
            if (!allowFirstTermination) {
              queueMicrotask(() => child.emit("error", Object.assign(
                new Error(`synthetic ${signal} delivery failure`),
                { code: "EPERM" },
              )));
              return false;
            }
            return realKill(signal);
          };
        }
      }
      return child;
    },
  });

  return {
    launcher,
    allowFirstTermination() {
      allowFirstTermination = true;
    },
  };
}

async function createRacingReadinessAllocator(responderLaunchToken) {
  let statusRequests = 0;
  let released = false;
  const server = createHttpServer((request, response) => {
    if (request.url !== "/__nexus/status") {
      response.writeHead(404);
      response.end();
      return;
    }

    statusRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: 2,
      ready: true,
      launchToken: responderLaunchToken,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const { port } = server.address();

  return {
    allocator: {
      async allocate() {
        return Object.freeze({
          host: "127.0.0.1",
          port,
          release() {
            if (released) {
              return false;
            }
            released = true;
            return true;
          },
        });
      },
    },
    get statusRequests() {
      return statusRequests;
    },
    get released() {
      return released;
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

test("RuntimeSupervisor supplies canonical launch environment and reaches running only after fixed readiness", async () => {
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 3_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 200,
    stopGracePeriodMs: 500,
  });

  const state = await supervisor.start(fixtureGame("fixture-one", ["--ready-delay-ms=40"]));
  assert.deepEqual(state, { gameId: "fixture-one", status: "running" });

  const active = supervisor.getActiveRuntime();
  assert.equal(active.gameId, "fixture-one");
  assert.equal(active.host, "127.0.0.1");
  assert.equal(active.basePath, "/games/fixture-one");
  assert.equal(active.status, "running");
  assert.equal(Object.hasOwn(active, "launchToken"), false);

  const response = await fetch(`http://${active.host}:${active.port}/fixture`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    host: active.host,
    port: active.port,
    basePath: active.basePath,
  });

  assert.deepEqual(await supervisor.stop(), {
    gameId: "fixture-one",
    status: "stopped",
    forced: false,
  });
  assert.equal(supervisor.getActiveRuntime(), null);
});

test("RuntimeSupervisor releases the allocated lease if launch-token creation fails before process launch", async () => {
  const recording = createRecordingAllocator();
  let launched = false;
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    launcher: {
      securityBoundary: "same-os-identity",
      launch() {
        launched = true;
      },
      waitForExit() {},
      stop() {},
    },
    launchTokenFactory: () => "",
  });

  await assert.rejects(
    () => supervisor.start(fixtureGame("bad-launch-token")),
    /launchTokenFactory must return a non-empty string/,
  );
  assert.equal(launched, false);
  assert.equal(recording.allocations.length, 1);
  assert.equal(recording.allocations[0].released, true);
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(supervisor.getState("bad-launch-token").status, "failed");
});

test("RuntimeSupervisor never accepts a valid-looking readiness responder that won the assigned port before the intended child", async () => {
  const expectedLaunchToken = "expected-launch-token";
  const racing = await createRacingReadinessAllocator("different-launch-token");
  const supervisor = new RuntimeSupervisor({
    allocator: racing.allocator,
    launchTokenFactory: () => expectedLaunchToken,
    startupTimeoutMs: 1_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 200,
  });

  try {
    await assert.rejects(
      () => supervisor.start(fixtureGame("port-race", ["--bind-delay-ms=120"])),
      /exited before becoming ready/,
    );
    assert.ok(racing.statusRequests > 0, "expected Nexus to observe the racing responder");
    assert.equal(racing.released, true);
    assert.equal(supervisor.getState("port-race").status, "failed");
    assert.equal(supervisor.getActiveRuntime(), null);
  } finally {
    await supervisor.stop().catch(() => undefined);
    await racing.close();
  }
});

test("RuntimeSupervisor fails closed on invalid readiness and releases startup resources", async () => {
  const allocated = [];
  const allocator = new PrivatePortAllocator();
  const recordingAllocator = {
    async allocate() {
      const lease = await allocator.allocate();
      const record = { host: lease.host, port: lease.port, released: false };
      allocated.push(record);
      return Object.freeze({
        host: lease.host,
        port: lease.port,
        release() {
          record.released = true;
          return lease.release();
        },
      });
    },
  };
  const supervisor = new RuntimeSupervisor({
    allocator: recordingAllocator,
    startupTimeoutMs: 120,
    pollIntervalMs: 20,
    requestTimeoutMs: 50,
    stopGracePeriodMs: 300,
  });

  await assert.rejects(
    () => supervisor.start(fixtureGame("bad-status", ["--status-mode=malformed"])),
    /game readiness timed out/,
  );
  assert.equal(allocated.length, 1);
  assert.equal(allocated[0].released, true);
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(supervisor.getState("bad-status").status, "failed");
  await assertPortBindable(allocated[0].host, allocated[0].port);
});

test("RuntimeSupervisor stops and releases the active game before starting another", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-switch-"));
  const firstSignals = join(root, "first-signals.txt");
  const recording = createRecordingAllocator();
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 500,
  });

  try {
    const firstArgs = process.platform === "win32" ? [] : [`--signal-file=${firstSignals}`];
    await supervisor.start(fixtureGame("game-a", firstArgs));
    const first = supervisor.getActiveRuntime();
    await supervisor.start(fixtureGame("game-b"));
    const second = supervisor.getActiveRuntime();

    assert.equal(second.gameId, "game-b");
    assert.equal(supervisor.getState("game-a").status, "stopped");
    assert.equal(recording.allocations.length, 2);
    assert.equal(recording.allocations[0].released, true);
    assert.ok(
      recording.events.indexOf("release:1:true") < recording.events.indexOf("allocate:2"),
      `expected first release before replacement allocation, got ${recording.events.join(", ")}`,
    );

    if (process.platform !== "win32") {
      assert.match(await readFile(firstSignals, "utf8"), /SIGTERM/);
    }

    if (second.port === first.port) {
      const response = await fetch(`http://${second.host}:${second.port}/fixture`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        host: second.host,
        port: second.port,
        basePath: "/games/game-b",
      });
    } else {
      await assertPortBindable(first.host, first.port);
    }
  } finally {
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("RuntimeSupervisor retains the lease and blocks replacement allocation when signal delivery fails until definitive exit", async () => {
  const recording = createRecordingAllocator();
  const signalFailure = createFirstProcessSignalFailureLauncher();
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    launcher: signalFailure.launcher,
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 100,
  });

  try {
    await supervisor.start(fixtureGame("kill-failure-a", ["--exit-after-ready-ms=300"]));
    const first = supervisor.getActiveRuntime();

    await assert.rejects(
      () => supervisor.start(fixtureGame("kill-failure-b")),
      /failed to deliver SIGTERM to game process/,
    );

    assert.equal(recording.allocations.length, 1);
    assert.equal(recording.allocations[0].released, false);
    assert.equal(supervisor.getActiveRuntime().gameId, "kill-failure-a");
    assert.equal(supervisor.getState("kill-failure-a").status, "failed");
    const stillLive = await fetch(`http://${first.host}:${first.port}/fixture`);
    assert.equal(stillLive.status, 200);

    await waitUntil(() => recording.allocations[0].released);
    assert.equal(supervisor.getActiveRuntime(), null);
    assert.equal(recording.events.includes("allocate:2"), false);

    await supervisor.start(fixtureGame("kill-failure-b"));
    assert.equal(recording.allocations.length, 2);
    assert.ok(
      recording.events.indexOf("release:1:true") < recording.events.indexOf("allocate:2"),
      `expected confirmed exit/release before replacement allocation, got ${recording.events.join(", ")}`,
    );
  } finally {
    signalFailure.allowFirstTermination();
    await supervisor.stop().catch(() => undefined);
  }
});

test("RuntimeSupervisor retains a startup-failure lease when cleanup signaling fails and releases it on later definitive exit", async () => {
  const recording = createRecordingAllocator();
  const signalFailure = createFirstProcessSignalFailureLauncher();
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    launcher: signalFailure.launcher,
    startupTimeoutMs: 80,
    pollIntervalMs: 15,
    requestTimeoutMs: 30,
    stopGracePeriodMs: 50,
  });

  try {
    await assert.rejects(
      () => supervisor.start(fixtureGame("startup-cleanup-failure", [
        "--status-mode=malformed",
        "--exit-after-ready-ms=300",
      ])),
      /game readiness timed out/,
    );

    assert.equal(recording.allocations.length, 1);
    assert.equal(recording.allocations[0].released, false);
    assert.equal(supervisor.getActiveRuntime().gameId, "startup-cleanup-failure");
    assert.equal(supervisor.getState("startup-cleanup-failure").status, "failed");
    assert.match(supervisor.getState("startup-cleanup-failure").error, /cleanup failed: failed to deliver SIGTERM/);

    await waitUntil(() => recording.allocations[0].released);
    assert.equal(supervisor.getActiveRuntime(), null);

    await supervisor.start(fixtureGame("after-startup-cleanup-failure"));
    assert.equal(recording.allocations.length, 2);
    assert.ok(
      recording.events.indexOf("release:1:true") < recording.events.indexOf("allocate:2"),
      `expected later definitive exit/release before recovery allocation, got ${recording.events.join(", ")}`,
    );
  } finally {
    signalFailure.allowFirstTermination();
    await supervisor.stop().catch(() => undefined);
  }
});

test("RuntimeSupervisor uses forced shutdown fallback when SIGTERM does not stop a Linux game", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-force-"));
  const signals = join(root, "signals.txt");
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 50,
  });

  try {
    await supervisor.start(fixtureGame("force-stop", [
      `--signal-file=${signals}`,
      "--ignore-sigterm",
    ]));
    const result = await supervisor.stop();
    assert.equal(result.forced, true);
    assert.match(await readFile(signals, "utf8"), /SIGTERM/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RuntimeSupervisor enforces the absolute startup deadline against trickling readiness and unblocks queued lifecycle work", async () => {
  const recording = createRecordingAllocator();
  const supervisor = new RuntimeSupervisor({
    allocator: recording.allocator,
    startupTimeoutMs: 150,
    pollIntervalMs: 20,
    requestTimeoutMs: 1_000,
    stopGracePeriodMs: 300,
  });

  try {
    const startedAt = Date.now();
    const stalledStart = supervisor.start(fixtureGame("trickle-start", ["--status-mode=trickle"]));
    const queuedStart = supervisor.start(fixtureGame("after-trickle"));

    await assert.rejects(stalledStart, /game readiness timed out/);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 600, `startup deadline took ${elapsedMs}ms`);

    assert.deepEqual(await queuedStart, { gameId: "after-trickle", status: "running" });
    assert.equal(recording.allocations.length, 2);
    assert.equal(recording.allocations[0].released, true);
    assert.ok(
      recording.events.indexOf("release:1:true") < recording.events.indexOf("allocate:2"),
      `expected failed startup cleanup before queued allocation, got ${recording.events.join(", ")}`,
    );
  } finally {
    await supervisor.stop();
  }
});

test("RuntimeSupervisor remains live when a supervised game emits output beyond pipe capacity before readiness", async () => {
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 3_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 300,
  });

  try {
    assert.deepEqual(
      await supervisor.start(fixtureGame("noisy-runtime", ["--output-bytes=2097152"])),
      { gameId: "noisy-runtime", status: "running" },
    );

    const active = supervisor.getActiveRuntime();
    const response = await fetch(`http://${active.host}:${active.port}/fixture`);
    assert.equal(response.status, 200);
  } finally {
    await supervisor.stop();
  }
});

test("RuntimeSupervisor observes an unexpected running-process exit, marks failure, and releases the lease", async () => {
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 200,
  });

  await supervisor.start(fixtureGame("crash-game", ["--exit-after-ready-ms=30"]));
  const active = supervisor.getActiveRuntime();
  assert.equal(active.status, "running");

  const deadline = Date.now() + 2_000;
  while (supervisor.getState("crash-game").status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(supervisor.getState("crash-game").status, "failed");
  assert.match(supervisor.getState("crash-game").error, /exited unexpectedly/);
  assert.equal(supervisor.getActiveRuntime(), null);
  await assertPortBindable(active.host, active.port);
});

test("RuntimeSupervisor treats child exit before readiness as startup failure and frees the active slot", async () => {
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 1_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 100,
  });
  const game = fixtureGame("early-exit");
  game.manifest.runtime.args = ["-e", "process.exit(12)"];

  await assert.rejects(() => supervisor.start(game), /exited before becoming ready/);
  assert.equal(supervisor.getState("early-exit").status, "failed");
  assert.equal(supervisor.getActiveRuntime(), null);
});

test("RuntimeSupervisor serializes concurrent start requests and leaves only the later game active", async () => {
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 300,
  });

  const firstStart = supervisor.start(fixtureGame("queued-a", ["--ready-delay-ms=20"]));
  const secondStart = supervisor.start(fixtureGame("queued-b"));
  await Promise.all([firstStart, secondStart]);

  assert.equal(supervisor.getState("queued-a").status, "stopped");
  assert.equal(supervisor.getState("queued-b").status, "running");
  assert.equal(supervisor.getActiveRuntime().gameId, "queued-b");
  await supervisor.stop();
});
