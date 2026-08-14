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
  assert.deepEqual(await library.json(), { games: [] });

  const portal = await fetch(`${origin}/`);
  assert.equal(portal.status, 200);
  assert.match(await portal.text(), /Tabletop Nexus/);
});

test("server API never exposes configured paths or runtime commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-server-"));
  const gameRoot = join(root, "secret-game-path");
  await mkdir(gameRoot);
  await writeFile(
    join(gameRoot, "boardgame.json"),
    JSON.stringify({
      schema: 1,
      id: "safe-game",
      name: "Safe Game",
      players: { min: 1, max: 2 },
      capabilities: { tvLess: true },
      runtime: { command: "secret-command", args: ["--secret"], healthPath: "/healthz" },
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
  assert.deepEqual(JSON.parse(text), {
    games: [
      {
        id: "safe-game",
        name: "Safe Game",
        players: { min: 1, max: 2 },
        capabilities: { tvLess: true },
        status: "configured",
      },
    ],
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
