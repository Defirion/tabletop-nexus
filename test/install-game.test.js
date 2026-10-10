import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installGame } from "../deploy/install-game.mjs";

async function fixture(t, pkg, locks) {
  const cwd = await mkdtemp(join(tmpdir(), "nexus-install-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "package.json"), JSON.stringify(pkg));
  for (const lock of locks) await writeFile(join(cwd, lock), "{}");
  return cwd;
}

test("npm builds before removing development dependencies", async (t) => {
  const cwd = await fixture(t, { scripts: { build: "build" } }, ["package-lock.json"]);
  const calls = [];
  installGame({ cwd, run: (command, args, options) => {
    assert.equal(options.cwd, cwd);
    assert.equal(options.env.CI, "true");
    calls.push([command, ...args]);
  } });
  assert.deepEqual(calls, [
    ["npm", "ci", "--include=dev", "--no-audit", "--no-fund"],
    ["npm", "run", "build"],
    ["npm", "prune", "--omit=dev", "--no-audit", "--no-fund"],
  ]);
});

test("pnpm uses its pinned version and frozen workspace installs around the build", async (t) => {
  const cwd = await fixture(t, { packageManager: "pnpm@11.21.0", scripts: { build: "build" } }, ["pnpm-lock.yaml"]);
  const calls = [];
  installGame({ cwd, run: (command, args) => calls.push([command, ...args]) });
  assert.equal(calls[0][0], "npm");
  assert.equal(calls[0].at(-1), "pnpm@11.21.0");
  assert.ok(calls[0].includes("--ignore-scripts"));
  assert.deepEqual(calls.slice(1).map(call => call.slice(2)), [
    ["install", "--frozen-lockfile", "--prod=false"],
    ["run", "build"],
    ["install", "--frozen-lockfile", "--prod"],
  ]);
  assert.ok(calls.slice(1).every(call => call[0] === process.execPath && call[1] === calls[1][1]));
});

test("invalid or ambiguous package-manager selections fail before executing commands", async (t) => {
  for (const [pkg, locks] of [
    [{}, []], [{}, ["package-lock.json", "pnpm-lock.yaml"]],
    [{ packageManager: "pnpm@latest" }, ["pnpm-lock.yaml"]],
    [{ packageManager: "pnpm@11.21.0;evil" }, ["pnpm-lock.yaml"]],
    [{ packageManager: "pnpm@11.21.0" }, ["package-lock.json"]],
  ]) {
    const cwd = await fixture(t, pkg, locks);
    let called = false;
    assert.throws(() => installGame({ cwd, run: () => { called = true; } }));
    assert.equal(called, false);
  }
});

test("failed builds stop installation and propagate failure for retry", async (t) => {
  const cwd = await fixture(t, { packageManager: "pnpm@11.21.0", scripts: { build: "build" } }, ["pnpm-lock.yaml"]);
  const calls = [];
  assert.throws(() => installGame({ cwd, run: (command, args) => {
    calls.push(args);
    if (args.at(-1) === "build") throw new Error("build failed");
  } }), /build failed/);
  assert.equal(calls.length, 3, "must not run production install after a failed build");
});
