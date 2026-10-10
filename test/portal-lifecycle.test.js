import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { loadLibrary } from "../src/registry.js";
import { createNexusServer } from "../src/server.js";

const fixtureServer = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runtime-game/server.mjs");

async function setup(t, { args = [], startupTimeoutMs = 3_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-portal-"));
  const configPath = join(root, "nexus.config.json");
  const manifests = new Map();
  for (const id of ["game-a", "game-b"]) {
    const gameRoot = join(root, id);
    await mkdir(gameRoot);
    const manifest = {
      schema: 3, id, name: id, players: { min: 1, max: 4 },
      capabilities: { tvLess: true, dedicatedDisplay: id === "game-a" },
      runtime: { command: process.execPath, args: [fixtureServer, ...(id === "game-a" ? args : [])] },
    };
    manifests.set(id, manifest);
    await writeFile(join(gameRoot, "boardgame.json"), JSON.stringify(manifest));
  }
  await writeFile(configPath, JSON.stringify({ games: [{ path: "game-a" }, { path: "game-b" }] }));
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs, pollIntervalMs: 20, requestTimeoutMs: 100, stopGracePeriodMs: 200,
    launchTokenFactory: () => "private-portal-launch-token",
  });
  const server = createNexusServer(configPath, { supervisor });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await supervisor.stop();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const library = async () => (await fetch(`${origin}/api/games`)).json();
  const action = (id, operation, activeGameId = "", extraHeaders = {}) => fetch(`${origin}/api/games/${id}/${operation}`, {
    method: "POST",
    headers: { "x-nexus-action": "1", "x-nexus-active-game": activeGameId, origin, ...extraHeaders },
  });
  return { root, configPath, manifests, origin, supervisor, action, library };
}

async function waitUntil(check) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("portal state did not update before deadline");
}

async function assertPortReleased(runtime) {
  const probe = createPortProbe();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(runtime.port, runtime.host, resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}

test("portal starts, opens, switches and stops real fixture games through one origin", async (t) => {
  const { origin, supervisor, action, library } = await setup(t);
  let state = await library();
  assert.equal(state.runtime, null);
  assert.ok(state.games.every((game) => game.status === "configured" && !game.playUrl && !game.boardUrl));

  const started = await action("game-a", "start");
  assert.equal(started.status, 200);
  const first = supervisor.getActiveRuntime();
  state = await library();
  assert.deepEqual(state.runtime, { gameId: "game-a", status: "running" });
  assert.equal(state.games[0].playUrl, "/games/game-a/");
  assert.equal(state.games[0].boardUrl, "/games/game-a/board/");
  assert.equal((await fetch(`${origin}${state.games[0].playUrl}`)).status, 200);
  assert.equal((await fetch(`${origin}${state.games[0].boardUrl}`)).status, 200);
  const publicText = JSON.stringify(state);
  for (const secret of ["private-portal-launch-token", fixtureServer, process.execPath, '"port"', '"host"']) {
    assert.equal(publicText.includes(secret), false, secret);
  }

  assert.equal((await action("game-a", "start", "game-a")).status, 200);
  assert.equal(supervisor.getActiveRuntime().port, first.port, "repeated Start must not restart the game");
  assert.equal((await action("game-b", "start", "game-a")).status, 200);
  await assertPortReleased(first);
  state = await library();
  assert.equal(state.games[0].status, "stopped");
  assert.equal(state.games[0].playUrl, undefined);
  assert.equal(state.games[1].status, "running");
  assert.equal(state.games[1].boardUrl, undefined);
  assert.equal((await fetch(`${origin}/games/game-a/`)).status, 503);
  const second = supervisor.getActiveRuntime();
  assert.equal((await action("game-b", "stop")).status, 200);
  assert.equal((await library()).runtime, null);
  await assertPortReleased(second);
  assert.equal((await action("game-a", "start")).status, 200);
});

test("portal refuses cross-origin, simple, non-POST and aliased lifecycle requests", async (t) => {
  const { origin, action, supervisor } = await setup(t);
  const path = `${origin}/api/games/game-a/start`;
  for (const options of [
    { method: "POST" },
    { method: "POST", headers: { "x-nexus-action": "1", origin: "https://other.example" } },
    { method: "POST", headers: { "x-nexus-action": "1", origin: "null" } },
    { method: "POST", headers: { "x-nexus-action": "1", "sec-fetch-site": "cross-site" } },
  ]) assert.equal((await fetch(path, options)).status, 403);
  for (const method of ["GET", "HEAD", "OPTIONS", "PUT"]) {
    assert.equal((await fetch(path, { method })).status, 404);
  }
  for (const alias of ["%67ame-a", "GAME-A", "game-a/../game-a", "game-a;v"]) {
    // Send raw request targets for dot-segment aliases rather than letting fetch normalize them.
    const { request } = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const req = request(origin, {
        method: "POST", path: `/api/games/${alias}/start`, headers: { "x-nexus-action": "1" },
      }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      req.once("error", reject);
      req.end();
    });
    assert.equal(status, 404);
  }
  assert.equal((await action("unknown-game", "start")).status, 404);
  assert.equal(supervisor.getActiveRuntime(), null);
});

test("portal reports startup progress, rejects overlap and rejects stale host actions", async (t) => {
  const { action, library, supervisor } = await setup(t, { args: ["--ready-delay-ms=400"] });
  const starting = action("game-a", "start");
  await waitUntil(async () => (await library()).games[0].status === "starting");
  const state = await library();
  assert.equal(state.busy, true);
  assert.equal(state.games[0].playUrl, undefined);
  const overlapping = await action("game-b", "start");
  assert.equal(overlapping.status, 409);
  assert.deepEqual(await overlapping.json(), { error: "LIFECYCLE_BUSY" });
  assert.equal((await starting).status, 200);

  const staleStart = await action("game-b", "start", "");
  assert.equal(staleStart.status, 409);
  assert.deepEqual(await staleStart.json(), { error: "RUNTIME_CHANGED" });
  const staleStop = await action("game-b", "stop");
  assert.equal(staleStop.status, 409);
  assert.equal(supervisor.getActiveRuntime().gameId, "game-a");
  assert.equal((await library()).busy, false);
});

test("portal contains bounded startup failure and permits recovery", async (t) => {
  const { root, manifests, action, library, supervisor } = await setup(t, {
    args: ["--ready-delay-ms=10000"], startupTimeoutMs: 800,
  });
  const failed = await action("game-a", "start");
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "LIFECYCLE_FAILED" });
  const state = await library();
  assert.equal(state.runtime, null);
  assert.equal(state.games[0].status, "failed");
  assert.equal(state.games[0].failureReason, "startup");
  assert.equal(state.games[0].playUrl, undefined);
  assert.match(state.games[0].message, /Try starting it again/);
  assert.equal(JSON.stringify(state).includes("private-portal-launch-token"), false);
  manifests.get("game-a").runtime.args = [fixtureServer];
  await writeFile(join(root, "game-a/boardgame.json"), JSON.stringify(manifests.get("game-a")));
  assert.equal((await action("game-a", "start")).status, 200);
  assert.equal(supervisor.getActiveRuntime().status, "running");
});

test("changed registrations lose ready links and removed or invalid registrations can still stop", async (t) => {
  const { root, configPath, manifests, action, library, supervisor } = await setup(t);
  assert.equal((await action("game-a", "start")).status, 200);
  manifests.get("game-a").runtime.args.push("--bind-delay-ms=50");
  await writeFile(join(root, "game-a/boardgame.json"), JSON.stringify(manifests.get("game-a")));
  let state = await library();
  assert.equal(state.games[0].playUrl, undefined);
  assert.match(state.games[0].message, /configuration changed/);
  await writeFile(configPath, JSON.stringify({ games: [] }));
  state = await library();
  assert.deepEqual(state.games, []);
  assert.equal(state.runtime.gameId, "game-a");
  await writeFile(configPath, "{");
  assert.equal((await action("game-a", "stop")).status, 200);
  assert.equal(supervisor.getActiveRuntime(), null);
});

test("targeted supervisor stop checks identity after queued switches", async (t) => {
  const { root, manifests, supervisor } = await setup(t);
  const game = (id) => ({ root: join(root, id), manifest: manifests.get(id) });
  await supervisor.start(game("game-a"));
  const switching = supervisor.start(game("game-b"));
  const staleStop = assert.rejects(supervisor.stop("game-a"), { code: "RUNTIME_CHANGED" });
  await switching;
  await staleStop;
  assert.equal(supervisor.getActiveRuntime().gameId, "game-b");
});

test("portal reports Stopping and withholds ready links while owned proxy setup drains", async (t) => {
  const { configPath, action, library, supervisor } = await setup(t);
  await action("game-a", "start");
  const [game] = await loadLibrary(configPath);
  const reference = supervisor.acquireActiveRuntime(game);
  const stopping = action("game-a", "stop");
  try {
    await waitUntil(async () => (await library()).games[0].status === "stopping");
    const state = await library();
    assert.equal(state.busy, true);
    assert.equal(state.games[0].playUrl, undefined);
    assert.equal(state.games[0].boardUrl, undefined);
  } finally {
    reference.release();
  }
  assert.equal((await stopping).status, 200);
  assert.equal((await library()).games[0].status, "stopped");
});

test("portal observes unexpected fixture exit and removes ready links", async (t) => {
  const { action, library } = await setup(t, { args: ["--exit-after-ready-ms=200"] });
  assert.equal((await action("game-a", "start")).status, 200);
  await waitUntil(async () => (await library()).games[0].status === "failed");
  const state = await library();
  assert.equal(state.runtime, null);
  assert.equal(state.games[0].playUrl, undefined);
  assert.equal(state.games[0].boardUrl, undefined);
  assert.equal(state.games[0].failureReason, "runtime-exit");
  assert.match(state.games[0].message, /stopped unexpectedly/);
  assert.equal(JSON.stringify(state).includes("exited unexpectedly (code"), false);
});

test("cleanup errors retain a safe public diagnosis without exposing private supervisor state", async (t) => {
  const { configPath } = await setup(t);
  const privateError = "secret-root secret-command secret-token";
  const supervisor = {
    getActiveRuntime: () => ({ gameId: "game-a", status: "failed", host: "127.0.0.1", port: 55555 }),
    getState: (id) => ({ status: id === "game-a" ? "failed" : "configured", error: privateError }),
    acquireActiveRuntime: () => null,
    stop: async () => { throw new Error(privateError); },
  };
  const server = createNexusServer(configPath, { supervisor });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/games/game-a/stop`, {
    method: "POST", headers: { "x-nexus-action": "1", origin },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "LIFECYCLE_FAILED" });
  const state = await (await fetch(`${origin}/api/games`)).json();
  assert.deepEqual(state.runtime, { gameId: "game-a", status: "failed" });
  assert.match(state.games[0].message, /Cleanup could not be confirmed/);
  assert.equal(state.games[0].failureReason, "cleanup");
  assert.equal(JSON.stringify(state).includes("secret-"), false);
  assert.equal(state.games[0].playUrl, undefined);
});

test("portal exposes only the host-configured player origin and keeps administration at its request origin", async (t) => {
  const { configPath, origin, action, library, supervisor } = await setup(t);
  const games = [{ path: "game-a" }, { path: "game-b" }];
  await writeFile(configPath, JSON.stringify({ games, publicOrigin: "http://192.168.10.210:3001/", secret: "private-config-field" }));
  const response = await fetch(`${origin}/api/games`, {
    headers: { "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https", host: "attacker.test" },
  });
  const state = await response.json();
  assert.equal(state.publicOrigin, "http://192.168.10.210:3001");
  assert.equal(JSON.stringify(state).includes("private-config-field"), false);
  assert.equal((await action("game-a", "start", "", { origin: state.publicOrigin })).status, 403);
  assert.equal((await action("game-a", "start")).status, 200);
  assert.equal((await library()).games[0].playUrl, "/games/game-a/");
  assert.equal((await fetch(`${origin}/games/game-a/`)).status, 200);
  await writeFile(configPath, JSON.stringify({ games, publicOrigin: "http://localhost:3000" }));
  assert.equal((await fetch(`${origin}/api/games`)).status, 500);
  assert.equal((await action("game-a", "stop")).status, 200);
  assert.equal(supervisor.getActiveRuntime(), null);
});
