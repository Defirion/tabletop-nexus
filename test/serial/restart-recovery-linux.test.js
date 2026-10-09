import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FileOwnershipJournal, OWNERSHIP_JOURNAL_FILE } from "../../src/runtime/ownership-journal.js";
import { createLocalGameProcessLauncher } from "../../src/runtime/process-launcher.js";
import { RuntimeSupervisor } from "../../src/runtime/supervisor.js";

// Real processes, real /proc: these prove the restart story end to end on the
// platform where Nexus can prove runtime ownership.
//
// This file lives in test/serial/ and runs in its own `node --test` pass (see the
// package.json test script). It starts many Node processes, which slows every
// other file's fixture startup and widens the documented probe-to-bind window
// for private ports; run alone, it cannot disturb them.
const linuxOnly = { skip: process.platform !== "linux" };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "runtime-game");
const fixtureServer = join(fixtureRoot, "server.mjs");
const harness = join(repoRoot, "fixtures", "nexus-harness.mjs");

function isLive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true, `condition was not met within ${timeoutMs}ms`);
}

// Test files run in parallel on one machine and every Nexus supervisor probes for
// ephemeral loopback ports, so a just-released port can be held for a moment by
// an unrelated probe. Only a holder that outlives the wait indicates a leak.
async function assertPortBindable(host, port, waitMs = 3_000) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const probe = createServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen({ host, port, exclusive: true }, resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
      return;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "nexus-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const pidsFile = join(root, "pids.txt");
  return { root, stateDir, pidsFile };
}

function fixtureGame(id, args = []) {
  return {
    root: fixtureRoot,
    manifest: { id, runtime: { command: process.execPath, args: [fixtureServer, ...args] } },
  };
}

/** Starts the harness "Nexus" and resolves once its game is ready. */
async function startHarness(stateDir, args, env = {}) {
  const child = spawn(process.execPath, [harness, stateDir, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = String(chunk).split("\n").find((entry) => entry.startsWith("{"));
      if (line !== undefined) resolve(JSON.parse(line));
    });
    exited.then(() => reject(new Error(`harness exited before ready: ${output}`)));
  });
  return { child, exited, ready };
}

function readOwnership(stateDir) {
  const stored = new FileOwnershipJournal({ directory: stateDir }).read();
  assert.equal(stored.status, "entry");
  return stored.entry;
}

async function readPids(pidsFile) {
  const [rootPid, helperPid] = (await readFile(pidsFile, "utf8")).trim().split(/\r?\n/).map(Number);
  return { rootPid, helperPid };
}

function recoveringSupervisor(stateDir, options = {}) {
  return new RuntimeSupervisor({
    launcher: createLocalGameProcessLauncher({ orphanGracePeriodMs: 300 }),
    journal: new FileOwnershipJournal({ directory: stateDir }),
    startupTimeoutMs: 5_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 200,
    stopGracePeriodMs: 200,
    recoveryPollMs: 50,
    recoveryDeadlineMs: 4_000,
    ...options,
  });
}

test("crash and restart: the game's own controller removes it when Nexus is killed, and the new Nexus finds a clean slate", linuxOnly, async (t) => {
  const { stateDir, pidsFile } = await scratch(t);
  const { child, exited, ready } = await startHarness(stateDir, [
    "--helper-listener-root", `--runtime-pids-file=${pidsFile}`,
  ]);
  t.after(() => child.kill("SIGKILL"));

  const entry = readOwnership(stateDir);
  assert.equal(entry.gameId, "harness-game");
  assert.equal(entry.privatePort, ready.port);
  const { controllerPid, processGroupId } = entry.ownership;
  assert.equal(processGroupId, controllerPid);
  const { rootPid, helperPid } = await readPids(pidsFile);
  for (const pid of [controllerPid, rootPid, helperPid]) assert.equal(isLive(pid), true);

  child.kill("SIGKILL");
  await exited;

  // The restarted Nexus starts reconciling right away, possibly while the
  // controller is still removing the old game.
  const supervisor = recoveringSupervisor(stateDir);
  t.after(() => supervisor.stop().catch(() => undefined));
  await supervisor.recover();
  await waitUntil(() => supervisor.getActiveRuntime() === null);
  for (const pid of [controllerPid, rootPid, helperPid]) assert.equal(isLive(pid), false, `pid ${pid}`);
  await assertPortBindable(ready.host, ready.port);
  assert.deepEqual(new FileOwnershipJournal({ directory: stateDir }).read(), { status: "empty" });

  assert.deepEqual(await supervisor.start(fixtureGame("after-crash")), { gameId: "after-crash", status: "running" });
  await supervisor.stop();
});

test("crash and restart: a game that ignores SIGTERM is still removed from inside its own group", linuxOnly, async (t) => {
  const { stateDir, pidsFile } = await scratch(t);
  const { child, exited, ready } = await startHarness(stateDir, [
    "--helper-listener-root", "--ignore-sigterm", "--helper-ignore-sigterm", `--runtime-pids-file=${pidsFile}`,
  ]);
  t.after(() => child.kill("SIGKILL"));
  const { controllerPid } = readOwnership(stateDir).ownership;
  const { rootPid, helperPid } = await readPids(pidsFile);

  child.kill("SIGKILL");
  await exited;
  await waitUntil(() => [controllerPid, rootPid, helperPid].every((pid) => !isLive(pid)));
  await assertPortBindable(ready.host, ready.port);

  const supervisor = recoveringSupervisor(stateDir);
  await supervisor.recover();
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(supervisor.getState("harness-game").status, "configured");
  assert.deepEqual(new FileOwnershipJournal({ directory: stateDir }).read(), { status: "empty" });
});

test("interrupted launch: a controller that never received its start message launches nothing", linuxOnly, async (t) => {
  const { stateDir, pidsFile } = await scratch(t);
  const child = spawn(process.execPath, [
    harness, stateDir, "--helper-listener-root", `--runtime-pids-file=${pidsFile}`,
  ], { env: { ...process.env, HARNESS_DIE_AFTER_RECORD: "1" }, stdio: "ignore" });
  const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, "SIGKILL");

  // The write-ahead record survived, naming the controller that was left behind.
  const entry = readOwnership(stateDir);
  assert.equal(entry.phase, "launching");
  const { controllerPid } = entry.ownership;
  await waitUntil(() => !isLive(controllerPid));
  await assert.rejects(readFile(pidsFile), { code: "ENOENT" }, "the game process must never have run");
  await assertPortBindable("127.0.0.1", entry.privatePort);

  const supervisor = recoveringSupervisor(stateDir);
  await supervisor.recover();
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.deepEqual(new FileOwnershipJournal({ directory: stateDir }).read(), { status: "empty" });
  await supervisor.start(fixtureGame("after-interrupt"));
  await supervisor.stop();
});

test("failed cleanup: with no controller left, the survivors are reported and never signalled from outside", linuxOnly, async (t) => {
  const { stateDir, pidsFile } = await scratch(t);
  const { child, exited, ready } = await startHarness(stateDir, [
    "--helper-listener-root", `--runtime-pids-file=${pidsFile}`,
  ]);
  const { controllerPid, processGroupId } = readOwnership(stateDir).ownership;
  const { rootPid, helperPid } = await readPids(pidsFile);
  t.after(() => {
    // Test cleanup only, standing in for the host operator; Nexus never does this.
    try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already gone */ }
    child.kill("SIGKILL");
  });

  // Take the controller out first, then Nexus: the runtime survives unowned.
  process.kill(controllerPid, "SIGKILL");
  await waitUntil(() => !isLive(controllerPid));
  child.kill("SIGKILL");
  await exited;
  assert.equal(isLive(rootPid), true);
  assert.equal(isLive(helperPid), true);

  const warnings = [];
  const supervisor = recoveringSupervisor(stateDir, { logger: { info() {}, warn: (m) => warnings.push(m) } });
  t.after(() => supervisor.stop().catch(() => undefined));
  await supervisor.recover();

  assert.equal(supervisor.getState("harness-game").status, "failed");
  assert.equal(supervisor.getActiveRuntime().recovered, true);
  assert.match(warnings.join("\n"), /controller is gone/);
  await assert.rejects(
    () => supervisor.start(fixtureGame("replacement")),
    (error) => error.code === "RECOVERY_UNRESOLVED",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(isLive(rootPid), true, "Nexus must not signal a runtime it can no longer anchor");
  assert.equal(isLive(helperPid), true);
  assert.equal(supervisor.getActiveRuntime().gameId, "harness-game", "the slot stays held");
  await assert.rejects(() => assertPortBindable(ready.host, ready.port, 0), { code: "EADDRINUSE" });

  // Once the host removes the survivors, the state resolves by itself.
  process.kill(-processGroupId, "SIGKILL");
  await waitUntil(() => supervisor.getState("harness-game").status === "stopped");
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.deepEqual(new FileOwnershipJournal({ directory: stateDir }).read(), { status: "empty" });
  await supervisor.start(fixtureGame("replacement"));
  await supervisor.stop();
});

test("a recycled process-group number is never mistaken for the old runtime", linuxOnly, async (t) => {
  const { stateDir } = await scratch(t);
  const journal = new FileOwnershipJournal({ directory: stateDir });
  // A live process group (this test runner's own) recorded as if it were a leftover:
  // it has the right number but not the recorded lifecycle token.
  journal.write({
    gameId: "stale-game",
    privatePort: 45999,
    phase: "running",
    launchedAt: new Date().toISOString(),
    ownership: {
      kind: "linux-process-group",
      lifecycleToken: "token-nobody-holds",
      processGroupId: process.pid,
      controllerPid: process.pid,
    },
  });
  const supervisor = recoveringSupervisor(stateDir);
  await supervisor.recover();
  assert.equal(supervisor.getActiveRuntime(), null);
  assert.equal(isLive(process.pid), true);
  assert.deepEqual(journal.read(), { status: "empty" });
});

// ---- the real entry point -------------------------------------------------

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startNexus(scratchDir, { configPath, port }) {
  const child = spawn(process.execPath, [join(repoRoot, "src", "server.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NEXUS_CONFIG: configPath,
      NEXUS_STATE_DIR: join(scratchDir, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const origin = `http://127.0.0.1:${port}`;
  await waitUntil(() => output.includes("listening"), 10_000);
  const library = async () => (await fetch(`${origin}/api/games`)).json();
  const start = (id, active = "") => fetch(`${origin}/api/games/${id}/start`, {
    method: "POST",
    headers: { "x-nexus-action": "1", "x-nexus-active-game": active, origin },
  });
  return { child, exited, library, start, output: () => output };
}

async function nexusConfig(root) {
  const gameDir = join(root, "game-a");
  await mkdir(gameDir);
  await writeFile(join(gameDir, "boardgame.json"), JSON.stringify({
    schema: 3,
    id: "game-a",
    name: "Game A",
    players: { min: 1, max: 4 },
    capabilities: { tvLess: true },
    runtime: { command: process.execPath, args: [fixtureServer] },
  }));
  const configPath = join(root, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [{ path: "game-a" }] }));
  return configPath;
}

test("clean restart: SIGTERM stops the active game before Nexus exits", linuxOnly, async (t) => {
  const { root, stateDir } = await scratch(t);
  const port = await freePort();
  const nexus = await startNexus(root, { configPath: await nexusConfig(root), port });
  t.after(() => nexus.child.kill("SIGKILL"));

  assert.equal((await nexus.start("game-a")).status, 200);
  const { controllerPid } = readOwnership(stateDir).ownership;
  const privatePort = readOwnership(stateDir).privatePort;
  assert.equal(isLive(controllerPid), true);

  nexus.child.kill("SIGTERM");
  assert.deepEqual(await nexus.exited, { code: 0, signal: null }, nexus.output());
  assert.equal(isLive(controllerPid), false);
  await assertPortBindable("127.0.0.1", privatePort);
  await assert.rejects(readFile(join(stateDir, OWNERSHIP_JOURNAL_FILE)), { code: "ENOENT" });

  // The next Nexus starts with nothing on the table.
  const again = await startNexus(root, { configPath: join(root, "nexus.config.json"), port: await freePort() });
  t.after(() => again.child.kill("SIGKILL"));
  const state = await again.library();
  assert.equal(state.runtime, null);
  assert.equal(state.games[0].status, "configured");
  assert.equal((await again.start("game-a")).status, 200);
  again.child.kill("SIGTERM");
  await again.exited;
});

test("crash and restart through the real entry point: the portal never shows a ghost session", linuxOnly, async (t) => {
  const { root, stateDir } = await scratch(t);
  const configPath = await nexusConfig(root);
  const first = await startNexus(root, { configPath, port: await freePort() });
  t.after(() => first.child.kill("SIGKILL"));

  assert.equal((await first.start("game-a")).status, 200);
  const { controllerPid } = readOwnership(stateDir).ownership;
  first.child.kill("SIGKILL");
  await first.exited;

  const second = await startNexus(root, { configPath, port: await freePort() });
  t.after(() => second.child.kill("SIGKILL"));
  // Immediately after restart the portal is truthful: either the old session is
  // still being removed (and says so) or it is already gone. Never "running".
  const early = await second.library();
  assert.notEqual(early.games[0].status, "running");
  assert.equal(early.games[0].playUrl, undefined);
  if (early.runtime !== null) {
    assert.equal(early.runtime.recovered, true);
    assert.equal(early.runtime.status, "stopping");
  }

  await waitUntil(() => !isLive(controllerPid));
  let state;
  const deadline = Date.now() + 5_000;
  do {
    state = await second.library();
    if (state.runtime === null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(state.runtime, null);
  assert.equal((await second.start("game-a")).status, 200);
  second.child.kill("SIGTERM");
  await second.exited;
});
