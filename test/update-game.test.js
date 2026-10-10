import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exists = (path) => access(path).then(() => true, () => false);

test("failed reinstall and failed update invalidate markers so same-commit retries install", {
  skip: process.platform === "win32", timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-update-game-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const game = join(home, "games", "fixture");
  const bin = join(root, "bin");
  const marker = join(home, ".update-game", "fixture");
  const installs = join(root, "installs.txt");
  await mkdir(source);
  await mkdir(bin);
  await mkdir(join(home, "games"), { recursive: true });
  await mkdir(join(home, "config"));
  await writeFile(join(home, "config", "nexus.config.json"), JSON.stringify({ games: [{ path: "/games/fixture" }] }));
  const git = (cwd, ...args) => run("git", ["-C", cwd, ...args], { timeout: 10_000 });
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "Nexus test");
  await git(source, "config", "user.email", "nexus-test@example.invalid");
  await writeFile(join(source, "boardgame.json"), JSON.stringify({
    schema: 3, id: "fixture", name: "Fixture", players: { min: 1, max: 4 },
    capabilities: { tvLess: true }, runtime: { command: "node", args: ["server.mjs"] },
  }));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(join(source, "package-lock.json"), "{}");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  const first = (await git(source, "rev-parse", "HEAD")).stdout.trim();
  await run("git", ["clone", "--bare", source, remote]);
  await run("git", ["clone", remote, game]);
  await git(source, "remote", "add", "origin", remote);

  // Real local Git repositories; Docker only supplies manifest validation and
  // the install command boundary. Execute the script's actual sh -c program
  // with a deterministic npm double that wipes node_modules before failing.
  const dockerShim = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseManifest } from ${JSON.stringify(pathToFileURL(join(repo, "src/registry.js")).href)};
const args = process.argv.slice(2);
if (args[0] === "image") process.exit(0);
if (args[0] === "inspect") { console.log("true"); process.exit(0); }
if (args[0] === "exec") { console.log(process.env.TEST_ACTIVE ?? "<none>"); process.exit(0); }
if (args.includes("--input-type=module")) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const manifest = JSON.parse(raw);
  parseManifest(manifest);
  console.log(manifest.id);
  process.exit(0);
}
const mount = args[args.indexOf("-v") + 1];
const cwd = mount.slice(0, -":/work".length);
const result = spawnSync("sh", ["-c", args.at(-1)], { cwd, stdio: "inherit" });
process.exit(result.status ?? 1);
`;
  const npmShim = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
if (process.argv[2] !== "ci") throw new Error("unexpected npm command");
appendFileSync(process.env.TEST_INSTALLS, "ci\\n");
rmSync("node_modules", { recursive: true, force: true });
if (process.env.TEST_FAIL_INSTALL === "1") process.exit(42);
mkdirSync("node_modules");
writeFileSync("node_modules/installed", "complete");
`;
  for (const [name, script] of [["docker", dockerShim], ["npm", npmShim]]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  const update = async (args = [], overrides = {}) => {
    const options = { timeout: 15_000, env: { ...process.env, NEXUS_HOME: home,
      PATH: `${bin}:${process.env.PATH}`, TEST_INSTALLS: installs, ...overrides } };
    try {
      const result = await run("bash", [join(repo, "deploy/update-game.sh"), "fixture", ...args], options);
      return { code: 0, ...result };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const installCount = async () => (await readFile(installs, "utf8")).trim().split("\n").length;
  const success = async (args = []) => {
    const result = await update(args);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /nothing to do|does not list this game/);
  };

  await success();
  assert.equal((await readFile(marker, "utf8")).trim(), first);
  assert.equal(await installCount(), 1);
  const noop = await update();
  assert.equal(noop.code, 0);
  assert.match(noop.stdout, /nothing to do/);
  assert.equal(await installCount(), 1);

  const refused = await update(["--reinstall"], { TEST_ACTIVE: "fixture" });
  assert.notEqual(refused.code, 0);
  assert.equal((await readFile(marker, "utf8")).trim(), first, "refusal must preserve a good install");
  const failedReinstall = await update(["--reinstall"], { TEST_FAIL_INSTALL: "1" });
  assert.notEqual(failedReinstall.code, 0);
  assert.equal(await exists(marker), false);
  assert.equal(await exists(join(game, "node_modules")), false, "failing npm ci wiped the install");
  await success();
  assert.equal(await installCount(), 3);
  assert.equal((await readFile(marker, "utf8")).trim(), first);

  await writeFile(join(source, "new-version.txt"), "updated");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "updated");
  const second = (await git(source, "rev-parse", "HEAD")).stdout.trim();
  await git(source, "push", "origin", "main");
  const failedUpdate = await update([], { TEST_FAIL_INSTALL: "1" });
  assert.notEqual(failedUpdate.code, 0);
  assert.equal((await git(game, "rev-parse", "HEAD")).stdout.trim(), second);
  assert.equal(await exists(marker), false);
  await git(game, "checkout", "--detach", first);
  await success(["--ref", first]);
  assert.equal(await installCount(), 5);
  assert.equal((await readFile(marker, "utf8")).trim(), first);
  await success();
  assert.equal((await readFile(marker, "utf8")).trim(), second);
});
