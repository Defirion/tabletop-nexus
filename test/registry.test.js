import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CURRENT_GAME_SCHEMA, loadLibrary, loadLibraryConfiguration, parseManifest, toPublicGame } from "../src/registry.js";

const validManifest = Object.freeze({
  schema: 3,
  id: "fixture-game",
  name: "Fixture Game",
  description: "Original test fixture.",
  players: { min: 2, max: 4 },
  capabilities: { tvLess: true, personalDevices: true },
  runtime: { command: "node", args: ["server.js"] },
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

test("parseManifest accepts schema 3 without a configurable readiness path", () => {
  const manifest = parseManifest(cloneManifest());
  assert.equal(CURRENT_GAME_SCHEMA, 3);
  assert.equal(manifest.id, "fixture-game");
  assert.equal("healthPath" in manifest.runtime, false);
});

test("parseManifest rejects the former schema-2 contract instead of redefining it", () => {
  const oldManifest = cloneManifest({
    schema: 2,
  });
  assert.throws(() => parseManifest(oldManifest), /manifest\.schema must be 3/);
});

test("parseManifest accepts only the current integer manifest schema", () => {
  for (const schema of [undefined, 1, "3", 4]) {
    assert.throws(() => parseManifest(cloneManifest({ schema })), /manifest\.schema must be 3/);
  }
});

test("parseManifest ignores a legacy-looking runtime.healthPath field under schema 3 because readiness is fixed by contract", () => {
  const manifest = parseManifest(cloneManifest({
    runtime: { command: "node", args: ["server.js"], healthPath: "/not-used" },
  }));
  assert.equal(manifest.runtime.healthPath, "/not-used");
});

test("parseManifest rejects missing TV-less support", () => {
  for (const tvLess of [undefined, false, "true", 1]) {
    assert.throws(() => parseManifest(cloneManifest({ capabilities: { tvLess } })), /tvLess must be true/);
  }
});

test("optional device capabilities must be boolean when present", () => {
  for (const key of ["personalDevices", "dedicatedDisplay"]) {
    for (const value of [undefined, false, true]) {
      assert.doesNotThrow(() => parseManifest(cloneManifest({ capabilities: { tvLess: true, [key]: value } })));
    }
    for (const value of [null, "false", 0, {}]) {
      assert.throws(() => parseManifest(cloneManifest({ capabilities: { tvLess: true, [key]: value } })),
        new RegExp(`manifest.capabilities.${key} must be boolean`));
    }
  }
});

test("runtime launch values require an executable and an argument array", () => {
  for (const command of [undefined, "", "  ", 1]) {
    assert.throws(() => parseManifest(cloneManifest({ runtime: { command, args: [] } })), /command must be/);
  }
  for (const args of [undefined, "server.js", ["server.js", 1]]) {
    assert.throws(() => parseManifest(cloneManifest({ runtime: { command: "node", args } })), /args must be/);
  }
});

test("unknown manifest metadata is retained privately but never copied into public metadata", () => {
  const manifest = parseManifest(cloneManifest({
    launchToken: "secret-launch-token",
    custom: { root: "secret-root" },
    players: { min: 2, max: 4, private: "secret-player-field" },
    capabilities: { tvLess: true, dedicatedDisplay: false, private: "secret-capability-field" },
    runtime: { command: "node", args: ["--private"], healthPath: "/not-used" },
  }));
  assert.equal(manifest.custom.root, "secret-root");
  assert.deepEqual(toPublicGame({ root: "secret-config-path", manifest }), {
    id: "fixture-game", name: "Fixture Game", description: "Original test fixture.",
    players: { min: 2, max: 4 },
    capabilities: { tvLess: true, dedicatedDisplay: false },
    status: "configured",
  });
});

test("parseManifest rejects invalid player ranges", () => {
  assert.throws(() => parseManifest(cloneManifest({ players: { min: 4, max: 2 } })), /max must be >=/);
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
  assert.deepEqual(toPublicGame(game), {
    id: "fixture-game",
    name: "Fixture Game",
    description: "Original test fixture.",
    players: { min: 2, max: 4 },
    capabilities: { tvLess: true, personalDevices: true },
    status: "configured",
  });
  assert.equal(JSON.stringify(toPublicGame(game)).includes("server.js"), false);
});

test("loadLibrary rejects duplicate public identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
  for (const directory of ["one", "two"]) {
    const gameRoot = join(root, directory);
    await mkdir(gameRoot);
    await writeFile(join(gameRoot, "boardgame.json"), JSON.stringify(cloneManifest()));
  }
  await writeFile(join(root, "nexus.config.json"), JSON.stringify({ games: [{ path: "./one" }, { path: "./two" }] }));
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

test("configured player origin is optional, normalized and limited to a non-local HTTP(S) origin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-public-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "nexus.config.json");
  assert.deepEqual(await loadLibraryConfiguration(configPath), { games: [] });
  for (const [publicOrigin, expected] of [
    [undefined, undefined], ["http://192.168.10.210:3001/", "http://192.168.10.210:3001"],
    ["https://NEXUS.test:443/", "https://nexus.test"], ["http://[2001:db8::1]:3000", "http://[2001:db8::1]:3000"],
  ]) {
    await writeFile(configPath, JSON.stringify({ games: [], publicOrigin }));
    assert.equal((await loadLibraryConfiguration(configPath)).publicOrigin, expected);
    assert.deepEqual(await loadLibrary(configPath), []);
  }
  for (const publicOrigin of [null, 42, "", "nexus.test:3000", "ftp://nexus.test", "javascript:alert(1)",
    "http://user:password@nexus.test", "http://@nexus.test", "http://nexus.test/games/", "http://nexus.test/foo/..",
    "http://nexus.test/?secret", "http://nexus.test/#", "http://nexus.test/?", "http://nexus.test\\path",
    "http://localhost:3000", "http://LOCALHOST./", "http://game.localhost", "http://127.12.34.56:3000",
    "http://2130706433", "http://0.0.0.0:3000", "http://[::]:3000", "http://[::1]:3000",
    "http://[::ffff:127.0.0.2]:3000",
  ]) {
    await writeFile(configPath, JSON.stringify({ games: [], publicOrigin }));
    await assert.rejects(() => loadLibraryConfiguration(configPath), /config.publicOrigin must be/, publicOrigin);
  }
});
