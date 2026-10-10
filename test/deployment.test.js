import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const docker = (args, options = {}) => run("docker", args, { timeout: 90_000, ...options });

test("Compose mounts a config directory while preserving the container config path", async () => {
  const compose = await readFile(join(repo, "deploy/compose.yaml"), "utf8");
  assert.match(compose, /NEXUS_CONFIG: \/config\/nexus\.config\.json/);
  assert.match(compose, /source: \$\{NEXUS_HOME:-\/srv\/homestack\/nexus\}\/config\r?\n\s+target: \/config\r?\n\s+read_only: true/);
});

test("Docker sees atomically replaced config on library refresh without recreation", {
  skip: process.env.NEXUS_DOCKER_TESTS !== "1", timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-docker-config-"));
  const name = `nexus-config-test-${randomUUID()}`;
  const image = `${name}:test`;
  const configDir = join(root, "config");
  const gameDir = join(root, "games", "added-game");
  await mkdir(configDir);
  await mkdir(gameDir, { recursive: true });
  await writeFile(join(gameDir, "boardgame.json"), JSON.stringify({
    schema: 3, id: "added-game", name: "Added game", players: { min: 1, max: 4 },
    capabilities: { tvLess: true }, runtime: { command: "node", args: ["server.mjs"] },
  }));
  const configPath = join(configDir, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [], publicOrigin: "http://192.168.1.10:8400" }));
  const override = join(root, "override.yaml");
  await writeFile(override, `services:\n  nexus:\n    image: ${image}\n    container_name: ${name}\n    restart: "no"\n`);
  const env = { ...process.env, NEXUS_HOME: root, NEXUS_PORT: "0" };
  const composeArgs = ["compose", "-p", name, "-f", join(repo, "deploy/compose.yaml"), "-f", override];
  t.after(async () => {
    try { await docker([...composeArgs, "down"], { env }); }
    finally {
      await docker(["image", "rm", image]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
  await docker(["build", "-f", join(repo, "deploy/Dockerfile"), "-t", image, repo]);
  await docker([...composeArgs, "up", "-d", "--no-build"], { env });
  const inspect = async () => JSON.parse((await docker(["inspect", name])).stdout)[0];
  const before = await inspect();
  const port = before.NetworkSettings.Ports["3000/tcp"][0].HostPort;
  const origin = `http://127.0.0.1:${port}`;
  let initial;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/games`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { initial = await response.json(); break; }
    } catch { /* container startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(initial, "container did not become ready");
  assert.deepEqual(initial.games, []);
  assert.equal(initial.publicOrigin, "http://192.168.1.10:8400");
  const temporary = join(configDir, "next.json");
  await writeFile(temporary, JSON.stringify({ games: [{ path: "/games/added-game" }],
    publicOrigin: "http://192.168.1.20:8400" }));
  await rename(temporary, configPath);
  const response = await fetch(`${origin}/api/games`);
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.deepEqual(refreshed.games.map((game) => game.id), ["added-game"]);
  assert.equal(refreshed.publicOrigin, "http://192.168.1.20:8400");
  const after = await inspect();
  assert.equal(after.Id, before.Id);
  assert.equal(after.State.StartedAt, before.State.StartedAt);
});
