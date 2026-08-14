import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLibrary, parseManifest, toPublicGame } from "../src/registry.js";

const validManifest = Object.freeze({
  schema: 1,
  id: "fixture-game",
  name: "Fixture Game",
  description: "Original test fixture.",
  players: { min: 2, max: 4 },
  capabilities: { tvLess: true, personalDevices: true },
  runtime: {
    command: "node",
    args: ["server.js"],
    healthPath: "/healthz",
  },
});

function cloneManifest(overrides = {}) {
  return {
    ...validManifest,
    players: { ...validManifest.players },
    capabilities: { ...validManifest.capabilities },
    runtime: { ...validManifest.runtime, args: [...validManifest.runtime.args] },
    ...overrides,
  };
}

test("parseManifest accepts the schema-1 baseline", () => {
  assert.equal(parseManifest(cloneManifest()).id, "fixture-game");
});

test("parseManifest rejects missing TV-less support", () => {
  assert.throws(
    () => parseManifest(cloneManifest({ capabilities: { tvLess: false } })),
    /tvLess must be true/,
  );
});

test("parseManifest rejects invalid player ranges and health URLs", () => {
  assert.throws(() => parseManifest(cloneManifest({ players: { min: 4, max: 2 } })), /max must be >=/);
  assert.throws(
    () => parseManifest(cloneManifest({ runtime: { command: "node", args: [], healthPath: "//other-host/healthz" } })),
    /local absolute path/,
  );
  assert.throws(
    () => parseManifest(cloneManifest({ runtime: { command: "node", args: [], healthPath: "/healthz?ready=1" } })),
    /local absolute path/,
  );
});

test("loadLibrary treats a missing local config as an empty library", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
  assert.deepEqual(await loadLibrary(join(root, "missing.json")), []);
});

test("loadLibrary resolves game paths relative to config and exposes only safe metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
  const gameRoot = join(root, "games", "fixture");
  await mkdir(gameRoot, { recursive: true });
  await writeFile(join(gameRoot, "boardgame.json"), JSON.stringify(cloneManifest()));
  await writeFile(join(root, "nexus.config.json"), JSON.stringify({ games: [{ path: "./games/fixture" }] }));

  const [game] = await loadLibrary(join(root, "nexus.config.json"));
  assert.equal(game.root, gameRoot);

  const publicGame = toPublicGame(game);
  assert.deepEqual(publicGame, {
    id: "fixture-game",
    name: "Fixture Game",
    description: "Original test fixture.",
    players: { min: 2, max: 4 },
    capabilities: { tvLess: true, personalDevices: true },
    status: "configured",
  });
  assert.equal("root" in publicGame, false);
  assert.equal("runtime" in publicGame, false);
  assert.equal(JSON.stringify(publicGame).includes("server.js"), false);
});

test("loadLibrary rejects duplicate public identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
  for (const directory of ["one", "two"]) {
    const gameRoot = join(root, directory);
    await mkdir(gameRoot);
    await writeFile(join(gameRoot, "boardgame.json"), JSON.stringify(cloneManifest()));
  }
  await writeFile(
    join(root, "nexus.config.json"),
    JSON.stringify({ games: [{ path: "./one" }, { path: "./two" }] }),
  );

  await assert.rejects(() => loadLibrary(join(root, "nexus.config.json")), /duplicate game id: fixture-game/);
});

test("loadLibrary distinguishes absent config from malformed or incomplete configured games", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "{");
  await assert.rejects(() => loadLibrary(malformed), /config contains invalid JSON/);

  const config = join(root, "nexus.config.json");
  await writeFile(config, JSON.stringify({ games: [{ path: "./missing-game" }] }));
  await assert.rejects(() => loadLibrary(config), /manifest not found/);
});
