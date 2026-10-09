import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MemoryOwnershipJournal } from "../src/runtime/ownership-journal.js";
import { createLocalGameProcessLauncher } from "../src/runtime/process-launcher.js";
import { PrivatePortAllocator } from "../src/runtime/private-ports.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { createNexusServer, shutdownNexus } from "../src/server.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "runtime-game");
const fixtureServer = join(fixtureRoot, "server.mjs");

function fixtureGame(id, args = []) {
  return {
    root: fixtureRoot,
    manifest: {
      schema: 3,
      id,
      name: id,
      players: { min: 1, max: 4 },
      capabilities: { tvLess: true },
      runtime: { command: process.execPath, args: [fixtureServer, ...args] },
    },
  };
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

const LEFTOVER = Object.freeze({
  gameId: "old-game",
  privatePort: 45678,
  phase: "running",
  launchedAt: "2026-10-09T10:00:00.000Z",
  ownership: Object.freeze({ kind: "test", generation: "gen-old" }),
});

/**
 * Real fixture processes with the recovery surface of the Linux launcher, so the
 * supervisor's recovery logic is exercised on every platform. `inspect` stands
 * in for the launcher's generation-aware check of the live system.
 */
function recoverableLauncher({ inspect, failStops = 0 } = {}) {
  const real = createLocalGameProcessLauncher({ ownProcessGroup: false });
  const events = [];
  let remainingStopFailures = failStops;
  let generation = 0;
  const launcher = {
    events,
    securityBoundary: real.securityBoundary,
    recoverable: true,
    inspectRecovery(record) {
      const result = inspect(record);
      events.push(`inspect:${result.state}`);
      return result;
    },
    launch(spec, options) {
      generation += 1;
      options?.recordOwnership?.({ kind: "test", generation: `gen-${generation}` });
      events.push("launch");
      return real.launch(spec);
    },
    waitForExit: (handle) => real.waitForExit(handle),
    async stop(handle, options) {
      if (remainingStopFailures > 0) {
        remainingStopFailures -= 1;
        throw new Error("synthetic cleanup failure");
      }
      return real.stop(handle, options);
    },
  };
  if (inspect === undefined) {
    delete launcher.inspectRecovery;
  }
  return launcher;
}

function setup(t, { journal = new MemoryOwnershipJournal(), launcher, ...options } = {}) {
  const allocator = new PrivatePortAllocator();
  const claims = [];
  const claim = allocator.claim.bind(allocator);
  allocator.claim = (port) => {
    claims.push(port);
    return claim(port);
  };
  const warnings = [];
  const supervisor = new RuntimeSupervisor({
    allocator,
    launcher,
    journal,
    logger: { info() {}, warn: (message) => warnings.push(message) },
    startupTimeoutMs: 3_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 200,
    stopGracePeriodMs: 200,
    recoveryPollMs: 20,
    recoveryDeadlineMs: 2_000,
    ...options,
  });
  t.after(() => supervisor.stop().catch(() => undefined));
  return { supervisor, journal, allocator, claims, warnings, launcher };
}

test("ownership is recorded before the runtime starts and dropped at confirmed termination", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const { supervisor, journal } = setup(t, { launcher });

  await supervisor.start(fixtureGame("game-a"));
  const stored = journal.read();
  assert.equal(stored.status, "entry");
  assert.equal(stored.entry.gameId, "game-a");
  assert.equal(stored.entry.privatePort, supervisor.getActiveRuntime().port);
  assert.equal(stored.entry.phase, "running");
  assert.deepEqual(stored.entry.ownership, { kind: "test", generation: "gen-1" });

  await supervisor.stop();
  assert.equal(journal.read().status, "empty");
});

test("a journal that cannot be written aborts the launch before any runtime exists", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const journal = {
    read: () => ({ status: "empty" }),
    write() { throw new Error("disk full"); },
    clear() {},
  };
  const { supervisor, allocator } = setup(t, { journal, launcher });

  await assert.rejects(() => supervisor.start(fixtureGame("game-a")), /disk full/);
  assert.equal(launcher.events.includes("launch"), false, "the runtime must not launch untracked");
  assert.equal(supervisor.getState("game-a").status, "failed");
  assert.equal(supervisor.getActiveRuntime(), null);
  // The private port was released again.
  assert.notEqual(allocator.claim(1), null);
});

test("clean restart: no record means nothing to recover and a normal start", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => assert.fail("nothing to inspect") });
  const { supervisor } = setup(t, { launcher });

  await supervisor.recover();
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(supervisor.getState("old-game").status, "configured");
  assert.equal(supervisor.getRecovery(), null);
  assert.deepEqual(await supervisor.start(fixtureGame("game-a")), { gameId: "game-a", status: "running" });
});

test("crash and restart: a generation that is already gone only clears its record", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const journal = new MemoryOwnershipJournal();
  journal.write(LEFTOVER);
  const { supervisor, claims } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.equal(journal.read().status, "empty");
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(claims.length, 0, "an absent generation needs no port claim");
  await supervisor.start(fixtureGame("game-a"));
  assert.equal(supervisor.getActiveRuntime().gameId, "game-a");
});

test("crash and restart: a leftover runtime still being removed by its controller holds the single slot", async (t) => {
  let inspections = 0;
  const launcher = recoverableLauncher({
    inspect: () => (++inspections > 4 ? { state: "absent" } : { state: "present", controllerLive: true }),
  });
  const journal = new MemoryOwnershipJournal();
  journal.write(LEFTOVER);
  const { supervisor, claims, allocator } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.deepEqual(supervisor.getActiveRuntime(), {
    gameId: "old-game",
    host: "127.0.0.1",
    port: LEFTOVER.privatePort,
    basePath: "/games/old-game",
    status: "stopping",
    recovered: true,
  });
  assert.deepEqual(supervisor.getState("old-game"), { gameId: "old-game", status: "stopping", recovered: true });
  assert.deepEqual(claims, [LEFTOVER.privatePort]);
  assert.equal(allocator.claim(LEFTOVER.privatePort), null, "the old private port stays claimed");
  // A leftover is never adopted: not even a game with the same id can reach it.
  assert.equal(supervisor.acquireActiveRuntime(fixtureGame("old-game")), null);

  // Switching waits for the leftover to be provably gone, and only then launches.
  await supervisor.start(fixtureGame("game-a"));
  assert.ok(
    launcher.events.indexOf("inspect:absent") < launcher.events.indexOf("launch"),
    `replacement launched before the leftover was gone: ${launcher.events.join(", ")}`,
  );
  assert.equal(supervisor.getState("old-game").status, "stopped");
  assert.equal(supervisor.getActiveRuntime().gameId, "game-a");
  assert.equal(journal.read().entry.gameId, "game-a");
  assert.notEqual(allocator.claim(LEFTOVER.privatePort), null, "the old port claim was released");
});

test("interrupted launch: a leftover with no controller blocks replacement until it is gone", async (t) => {
  let gone = false;
  const launcher = recoverableLauncher({
    inspect: () => (gone ? { state: "absent" } : { state: "present", controllerLive: false }),
  });
  const journal = new MemoryOwnershipJournal();
  journal.write({ ...LEFTOVER, phase: "launching" });
  const { supervisor, allocator, warnings } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.equal(supervisor.getState("old-game").status, "failed");
  assert.equal(supervisor.getState("old-game").recovered, true);
  assert.match(warnings.join("\n"), /old-game.*still present.*controller is gone/s);

  await assert.rejects(
    () => supervisor.start(fixtureGame("game-a")),
    (error) => error.code === "RECOVERY_UNRESOLVED",
  );
  await assert.rejects(() => supervisor.stop("old-game"), (error) => error.code === "RECOVERY_UNRESOLVED");
  assert.equal(launcher.events.includes("launch"), false, "no replacement while ownership is unresolved");
  assert.equal(journal.read().status, "entry", "the evidence is kept while the runtime may exist");
  assert.equal(allocator.claim(LEFTOVER.privatePort), null);
  assert.equal(supervisor.getActiveRuntime().status, "failed");

  // Resolves by itself, and without any signal, once the generation disappears.
  gone = true;
  await waitUntil(() => supervisor.getState("old-game").status === "stopped");
  assert.equal(journal.read().status, "empty");
  assert.equal(supervisor.getActiveRuntime(), null);
  await supervisor.start(fixtureGame("game-a"));
});

test("a leftover that outlives the recovery deadline is reported failed, not assumed gone", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "present", controllerLive: true }) });
  const journal = new MemoryOwnershipJournal();
  journal.write(LEFTOVER);
  const { supervisor, warnings } = setup(t, { journal, launcher, recoveryDeadlineMs: 150 });

  await supervisor.recover();
  assert.equal(supervisor.getState("old-game").status, "stopping");
  await waitUntil(() => supervisor.getState("old-game").status === "failed");
  assert.match(warnings.join("\n"), /did not exit/);
  await assert.rejects(() => supervisor.start(fixtureGame("game-a")), /still present/);
  assert.equal(journal.read().status, "entry");
});

test("failed cleanup: inspection uncertainty is never treated as the runtime being gone", async (t) => {
  const launcher = recoverableLauncher({
    inspect: () => ({ state: "ambiguous", detail: "EACCES reading /proc" }),
  });
  const journal = new MemoryOwnershipJournal();
  journal.write(LEFTOVER);
  const { supervisor } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.equal(supervisor.getState("old-game").status, "failed");
  assert.match(supervisor.getState("old-game").error, /could not be verified: EACCES/);
  await assert.rejects(() => supervisor.start(fixtureGame("game-a")), /could not be verified/);
  assert.equal(journal.read().status, "entry");
  assert.equal(launcher.events.includes("launch"), false);
});

test("a launcher that cannot verify leftovers fails closed instead of discarding the record", async (t) => {
  const launcher = recoverableLauncher();
  const journal = new MemoryOwnershipJournal();
  journal.write(LEFTOVER);
  const { supervisor } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.equal(supervisor.getState("old-game").status, "failed");
  assert.match(supervisor.getState("old-game").error, /cannot verify leftover runtimes/);
  await assert.rejects(() => supervisor.start(fixtureGame("game-a")), /could not be verified/);
  assert.equal(journal.read().status, "entry");
});

test("failed cleanup after an ordinary stop keeps the ownership record until termination is confirmed", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }), failStops: 2 });
  const { supervisor, journal, allocator } = setup(t, { launcher });

  await supervisor.start(fixtureGame("game-a"));
  const { port } = supervisor.getActiveRuntime();
  await assert.rejects(() => supervisor.stop(), /synthetic cleanup failure/);
  assert.equal(journal.read().entry.gameId, "game-a");
  assert.equal(allocator.claim(port), null, "the lease stays held");
  await assert.rejects(() => supervisor.start(fixtureGame("game-b")), /synthetic cleanup failure/);
  assert.equal(launcher.events.filter((event) => event === "launch").length, 1, "no replacement launched");
  assert.equal(supervisor.getActiveRuntime().gameId, "game-a");

  await supervisor.stop();
  assert.equal(journal.read().status, "empty");
  await supervisor.start(fixtureGame("game-b"));
  assert.equal(supervisor.getActiveRuntime().gameId, "game-b");
});

test("an unexpected runtime exit drops the ownership record once termination is known", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const { supervisor, journal } = setup(t, { launcher });

  await supervisor.start(fixtureGame("game-a", ["--exit-after-ready-ms=150"]));
  await waitUntil(() => supervisor.getState("game-a").status === "failed");
  assert.equal(journal.read().status, "empty");
  assert.equal(supervisor.getActiveRuntime(), null);
});

test("a damaged ownership record blocks every start until it is cleared", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const journal = new MemoryOwnershipJournal();
  journal.corrupt("ownership record is not valid JSON");
  const { supervisor, warnings } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.deepEqual(supervisor.getRecovery(), { status: "blocked" });
  assert.match(warnings.join("\n"), /cannot interpret its runtime ownership record/);
  await assert.rejects(
    () => supervisor.start(fixtureGame("game-a")),
    (error) => error.code === "RECOVERY_BLOCKED",
  );
  assert.equal(launcher.events.includes("launch"), false);

  journal.clear();
  await supervisor.start(fixtureGame("game-a"));
  assert.equal(supervisor.getRecovery(), null);
  assert.equal(supervisor.getActiveRuntime().gameId, "game-a");
});

test("a blocked supervisor notices on its own when the damaged record is removed", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const journal = new MemoryOwnershipJournal();
  journal.corrupt();
  const { supervisor } = setup(t, { journal, launcher });

  await supervisor.recover();
  assert.notEqual(supervisor.getRecovery(), null);
  journal.clear();
  await waitUntil(() => supervisor.getRecovery() === null, 4_000);
});

// ---- portal API -----------------------------------------------------------

async function portal(t, supervisor) {
  const root = await mkdtemp(join(tmpdir(), "nexus-recovery-portal-"));
  for (const id of ["old-game", "game-a"]) {
    await mkdir(join(root, id));
    await writeFile(join(root, id, "boardgame.json"), JSON.stringify(fixtureGame(id).manifest));
  }
  const configPath = join(root, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [{ path: "old-game" }, { path: "game-a" }] }));
  // The same order startNexusServer uses: reconcile first, then serve. (That
  // entry point itself is covered with real processes in test/serial/.) The
  // server listens on port 0 directly rather than on a probed-then-released
  // port, which would race other test files' private-port allocations.
  await supervisor.recover();
  const server = createNexusServer(configPath, { supervisor });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    origin,
    library: async () => (await fetch(`${origin}/api/games`)).json(),
    start: (id, active = "") => fetch(`${origin}/api/games/${id}/start`, {
      method: "POST",
      headers: { "x-nexus-action": "1", "x-nexus-active-game": active, origin },
    }),
  };
}

test("portal reports a leftover runtime truthfully from its first response and keeps start paused", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "present", controllerLive: false }) });
  const journal = new MemoryOwnershipJournal();
  journal.write(LEFTOVER);
  const { supervisor } = setup(t, { journal, launcher });
  const { library, start } = await portal(t, supervisor);

  const state = await library();
  assert.deepEqual(state.runtime, { gameId: "old-game", status: "failed", recovered: true });
  assert.equal(state.games[0].status, "failed");
  assert.match(state.games[0].message, /Nexus restarted while this game was running/);
  assert.equal(state.games[0].playUrl, undefined);
  const publicText = JSON.stringify(state);
  for (const secret of ["gen-old", "45678", "launchedAt", "ownership"]) {
    assert.equal(publicText.includes(secret), false, secret);
  }

  const refused = await start("game-a", "old-game");
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: "LIFECYCLE_FAILED" });
  assert.equal(launcher.events.includes("launch"), false);
});

test("portal exposes a blocked recovery and refuses starts with a stable error", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const journal = new MemoryOwnershipJournal();
  journal.corrupt();
  const { supervisor } = setup(t, { journal, launcher });
  const { library, start } = await portal(t, supervisor);

  const state = await library();
  assert.equal(state.recovery.status, "blocked");
  assert.match(state.recovery.message, /cannot interpret/);
  assert.equal(state.runtime, null);
  const refused = await start("game-a");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "RECOVERY_BLOCKED" });
});

test("portal API omits the recovery field when nothing is blocked", async (t) => {
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const { supervisor } = setup(t, { launcher });
  const { library } = await portal(t, supervisor);
  assert.equal("recovery" in await library(), false);
});

// ---- orderly shutdown -----------------------------------------------------

test("orderly shutdown stops the active game so no runtime outlives Nexus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-shutdown-"));
  await mkdir(join(root, "game-a"));
  await writeFile(join(root, "game-a", "boardgame.json"), JSON.stringify(fixtureGame("game-a").manifest));
  const configPath = join(root, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [{ path: "game-a" }] }));
  const launcher = recoverableLauncher({ inspect: () => ({ state: "absent" }) });
  const { supervisor, journal } = setup(t, { launcher });
  const server = createNexusServer(configPath, { supervisor });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => rm(root, { recursive: true, force: true }));

  await supervisor.start(fixtureGame("game-a"));
  const runtime = supervisor.getActiveRuntime();
  await shutdownNexus(server, supervisor);

  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(supervisor.getState("game-a").status, "stopped");
  assert.equal(journal.read().status, "empty");
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(runtime.port, runtime.host, resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
  assert.equal(server.listening, false);
});
