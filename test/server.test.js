import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNexusServer } from "../src/server.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("server health and empty-library API are runnable without local config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-server-"));
  const server = createNexusServer(join(root, "missing.json"));
  t.after(() => close(server));
  const origin = await listen(server);

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const library = await fetch(`${origin}/api/games`);
  assert.equal(library.status, 200);
  assert.deepEqual(await library.json(), { games: [], runtime: null, busy: false });

  const portal = await fetch(`${origin}/`);
  assert.equal(portal.status, 200);
  const html = await portal.text();
  assert.match(html, /Tabletop Nexus/);

  // The portal's QR generator is served as a classic script ahead of app.js.
  assert.ok(html.indexOf('src="/qr.js"') !== -1 && html.indexOf('src="/qr.js"') < html.indexOf('src="/app.js"'));
  const qr = await fetch(`${origin}/qr.js`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /^text\/javascript/);
  assert.match(await qr.text(), /globalThis\.nexusQr/);
});

test("server API never exposes configured paths, runtime commands, tokens, or unknown metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-server-"));
  const gameRoot = join(root, "secret-game-path");
  await mkdir(gameRoot);
  await writeFile(
    join(gameRoot, "boardgame.json"),
    JSON.stringify({
      schema: 3,
      id: "safe-game",
      name: "Safe Game",
      players: { min: 1, max: 2, private: "secret-player-data" },
      capabilities: { tvLess: true, private: "secret-capability-data" },
      launchToken: "secret-launch-token",
      runtime: { command: "secret-command", args: ["--secret"] },
    }),
  );
  const configPath = join(root, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [{ path: gameRoot }] }));

  const server = createNexusServer(configPath);
  t.after(() => close(server));
  const origin = await listen(server);
  const response = await fetch(`${origin}/api/games`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(text.includes(gameRoot), false);
  assert.equal(text.includes("secret-command"), false);
  assert.equal(text.includes("--secret"), false);
  assert.equal(text.includes("secret-launch-token"), false);
  assert.equal(text.includes("secret-player-data"), false);
  assert.equal(text.includes("secret-capability-data"), false);
  assert.deepEqual(JSON.parse(text), {
    games: [{
      id: "safe-game",
      name: "Safe Game",
      players: { min: 1, max: 2 },
      capabilities: { tvLess: true },
      status: "configured",
    }],
    runtime: null,
    busy: false,
  });
});

test("server rejects unregistered paths and non-read methods", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-server-"));
  const server = createNexusServer(join(root, "missing.json"));
  t.after(() => close(server));
  const origin = await listen(server);

  const traversal = await fetch(`${origin}/../package.json`);
  assert.equal(traversal.status, 404);

  const post = await fetch(`${origin}/api/games`, { method: "POST" });
  assert.equal(post.status, 404);
});
