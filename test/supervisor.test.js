import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 2_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 100,
    stopGracePeriodMs: 500,
  });

  try {
    await supervisor.start(fixtureGame("game-a", [`--signal-file=${firstSignals}`]));
    const first = supervisor.getActiveRuntime();
    await supervisor.start(fixtureGame("game-b"));
    const second = supervisor.getActiveRuntime();

    assert.equal(second.gameId, "game-b");
    assert.notEqual(second.port, first.port);
    assert.equal(supervisor.getState("game-a").status, "stopped");
    assert.match(await readFile(firstSignals, "utf8"), /SIGTERM/);
    await assertPortBindable(first.host, first.port);
  } finally {
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
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
