import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FileDiagnosticWriter, RuntimeDiagnostics, drainRuntimeOutput } from "../src/runtime/diagnostics.js";
import { createLocalGameProcessLauncher } from "../src/runtime/process-launcher.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { createNexusServer, shutdownNexus } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "runtime-game");
function game(id, args = []) {
  return { root, manifest: {
    schema: 3, id, name: id, players: { min: 1, max: 4 }, capabilities: { tvLess: true },
    runtime: { command: process.execPath, args: [join(root, "server.mjs"), "--diagnostic-output", ...args] },
  } };
}
async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), "condition did not become true");
}

test("diagnostics cap each stream and launch history, copying snapshots and retiring old collectors", () => {
  const diagnostics = new RuntimeDiagnostics();
  const first = diagnostics.begin("first");
  first.write("stdout", Buffer.alloc(100_000, "x"));
  first.write("stdout", Buffer.from("END"));
  first.write("stderr", Buffer.from("error"));
  let snapshot = diagnostics.snapshot();
  assert.equal(snapshot.launches[0].stdout.text.length, 32768);
  assert.equal(snapshot.launches[0].stdout.droppedBytes, 100_003 - 32768);
  assert.ok(snapshot.launches[0].stdout.text.endsWith("END"));
  assert.equal(snapshot.launches[0].stderr.text, "error");
  snapshot.launches[0].status = "corrupted";
  assert.equal(diagnostics.snapshot().launches[0].status, "starting");
  for (let i = 0; i < 4; i++) diagnostics.begin(`later-${i}`);
  first.write("stdout", Buffer.alloc(100_000, "y"));
  snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.launches.map((launch) => launch.gameId), ["later-0", "later-1", "later-2", "later-3"]);
  assert.equal(new Set(snapshot.launches.map((launch) => launch.launchId)).size, 4);
});

test("diagnostics decode split UTF-8 and withhold split secrets from intermediate snapshots and EOF", () => {
  const diagnostics = new RuntimeDiagnostics();
  const sink = diagnostics.begin("secret-test");
  sink.addSecrets(["private-launch-token", "aaaa", "lifecycle-token"]);
  const bytes = Buffer.from("hello 🦜 ");
  sink.write("stdout", bytes.subarray(0, 8));
  sink.write("stdout", bytes.subarray(8));
  sink.write("stdout", Buffer.from("private-launch-"));
  assert.equal(diagnostics.snapshot().launches[0].stdout.text, "hello 🦜 ");
  sink.write("stdout", Buffer.from("token aaaa! lifecycle-"));
  sink.end("stdout");
  sink.end("stdout");
  sink.update({ status: "failed", failureReason: "startup", error: "private-launch-token failed" });
  const launch = diagnostics.snapshot().launches[0];
  assert.equal(launch.stdout.text, "hello 🦜 [redacted] [redacted]! ");
  assert.equal(launch.detail, "[redacted] failed");
  assert.equal(launch.failureReason, "startup");
});

test("an output sink failure never leaves game pipes undrained, including stream errors", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const output = Object.fromEntries(["addSecrets", "available", "write", "end", "error"].map((key) => [key, () => { throw new Error("sink failed"); }]));
  drainRuntimeOutput(child, output, ["secret"]);
  child.stdout.write(Buffer.alloc(100_000, "x"));
  child.stderr.emit("error", new Error("stream failed"));
  child.stdout.end();
  child.stderr.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdout.readableLength, 0);
  assert.equal(child.stderr.readableLength, 0);
});

test("slow diagnostic storage coalesces changes while output continues and failed storage disables further writes", async () => {
  let release;
  let calls = 0;
  const warnings = [];
  const diagnostics = new RuntimeDiagnostics({
    writer: { async write() { calls++; await new Promise((resolve) => { release = resolve; }); throw Object.assign(new Error("private failure"), { code: "ENOSPC" }); } },
    logger: { warn: (message) => warnings.push(message) },
  });
  const sink = diagnostics.begin("slow-store");
  const pending = diagnostics.flush();
  for (let i = 0; i < 100; i++) sink.write("stdout", Buffer.alloc(65536, "x"));
  assert.equal(calls, 1);
  assert.equal(diagnostics.snapshot().launches[0].stdout.text.length, 32768);
  release();
  await pending;
  sink.write("stdout", Buffer.from("still captured"));
  await diagnostics.flush();
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ENOSPC/);
  assert.ok(diagnostics.snapshot().launches[0].stdout.text.endsWith("still captured"));
});

test("diagnostic files replace snapshots atomically and use private Unix permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-diagnostic-file-"));
  try {
    const writer = new FileDiagnosticWriter({ directory });
    await writer.write({ version: 1, launches: ["first"] });
    await writer.write({ version: 1, launches: ["second"] });
    assert.deepEqual(JSON.parse(await readFile(writer.path, "utf8")), { version: 1, launches: ["second"] });
    if (process.platform !== "win32") {
      assert.equal((await lstat(writer.path)).mode & 0o777, 0o600);
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      await chmod(directory, 0o755);
      await assert.rejects(writer.write({}), /private to the Nexus user/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a flush completes under continued output and concurrent flushes serialize the latest pending snapshot", async () => {
  const snapshots = [];
  let release;
  const diagnostics = new RuntimeDiagnostics({ writer: {
    async write(value) {
      snapshots.push(value);
      if (snapshots.length === 1) await new Promise((resolve) => { release = resolve; });
    },
  } });
  const sink = diagnostics.begin("continued-output");
  const first = diagnostics.flush();
  sink.write("stderr", Buffer.from("arrived during write"));
  release();
  await first;
  assert.equal(snapshots.length, 1);
  await Promise.all([diagnostics.flush(), diagnostics.flush()]);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].launches[0].stderr.text, "arrived during write");
});

test("diagnostics refuse a symlinked directory and never overwrite a symlink target", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-diagnostic-link-"));
  try {
    const target = join(directory, "target");
    const writer = new FileDiagnosticWriter({ directory });
    await writeFile(target, "untouched");
    await symlink(target, writer.path);
    await writer.write({ safe: true });
    assert.equal(await readFile(target, "utf8"), "untouched");
    const linked = join(directory, "linked");
    await symlink(directory, linked);
    await assert.rejects(new FileDiagnosticWriter({ directory: linked }).write({}), /real directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real launcher drains noisy pre-readiness output, separates streams, redacts tokens, and retains stop/switch history", async () => {
  const diagnostics = new RuntimeDiagnostics();
  const supervisor = new RuntimeSupervisor({ diagnostics, startupTimeoutMs: 5000, pollIntervalMs: 20, stopGracePeriodMs: 300 });
  try {
    await supervisor.start(game("noisy", ["--output-bytes=1048576"]));
    await waitUntil(() => diagnostics.snapshot().launches[0].stderr.text.includes("fixture diagnostic stderr"));
    let launch = diagnostics.snapshot().launches[0];
    assert.equal(launch.status, "running");
    assert.equal(launch.outputAvailable, true);
    assert.ok(launch.stdout.droppedBytes > 0);
    assert.ok(launch.stderr.droppedBytes > 0);
    assert.match(launch.stdout.text, /fixture diagnostic stdout \[redacted\]/);
    assert.match(launch.stderr.text, process.platform === "linux" ? /stderr \[redacted\]/ : /stderr no-controller/);
    await supervisor.start(game("second"));
    launch = diagnostics.snapshot().launches[0];
    assert.equal(launch.status, "stopped");
    assert.ok(launch.endedAt);
    assert.ok(launch.exit);
    assert.equal(diagnostics.snapshot().launches[1].gameId, "second");
    await supervisor.stop();
    assert.equal(diagnostics.snapshot().launches[1].status, "stopped");
    assert.equal(supervisor.getActiveRuntime(), null);
  } finally { await supervisor.stop(); }
});

test("diagnostics retain startup failures, spawn failures, and unexpected exits after the active slot is released", async () => {
  const diagnostics = new RuntimeDiagnostics();
  const supervisor = new RuntimeSupervisor({ diagnostics, startupTimeoutMs: 1000, pollIntervalMs: 20, stopGracePeriodMs: 300 });
  try {
    await assert.rejects(supervisor.start(game("bad-ready", ["--status-mode=malformed"])));
    let launch = diagnostics.snapshot().launches[0];
    assert.equal(launch.failureReason, "startup");
    assert.match(launch.stderr.text, /fixture diagnostic stderr/);
    const missing = game("missing");
    missing.manifest.runtime.command = join(root, "does-not-exist");
    await assert.rejects(supervisor.start(missing));
    launch = diagnostics.snapshot().launches[1];
    assert.equal(launch.failureReason, "startup");
    assert.match(launch.exit.error, /ENOENT/);
    await supervisor.start(game("crashing", ["--exit-after-ready-ms=200"]));
    await waitUntil(() => diagnostics.snapshot().launches[2].failureReason === "runtime-exit");
    launch = diagnostics.snapshot().launches[2];
    assert.equal(launch.exit.code, 17);
    assert.equal(launch.status, "failed");
    assert.ok(launch.endedAt);
    assert.equal(supervisor.getActiveRuntime(), null);
  } finally { await supervisor.stop(); }
});

test("an opaque launcher without output support remains usable and reports output unavailable", async () => {
  const diagnostics = new RuntimeDiagnostics();
  const local = createLocalGameProcessLauncher();
  const launcher = { ...local, launch(spec) { return local.launch(spec); } };
  const supervisor = new RuntimeSupervisor({ diagnostics, launcher, startupTimeoutMs: 5000, pollIntervalMs: 20 });
  try {
    await supervisor.start(game("opaque"));
    assert.equal(diagnostics.snapshot().launches[0].outputAvailable, false);
    await supervisor.stop();
    assert.equal(diagnostics.snapshot().launches[0].status, "stopped");
  } finally { await supervisor.stop(); }
});

test("diagnostics preserve cleanup failure and output until a later definitive exit releases ownership", async () => {
  const diagnostics = new RuntimeDiagnostics();
  const local = createLocalGameProcessLauncher();
  let blocked = true;
  const launcher = { ...local, stop(handle, options) {
    if (blocked) throw new Error("synthetic cleanup failure");
    return local.stop(handle, options);
  } };
  const supervisor = new RuntimeSupervisor({ diagnostics, launcher, startupTimeoutMs: 5000, pollIntervalMs: 20 });
  try {
    await supervisor.start(game("late-exit", ["--exit-after-ready-ms=500"]));
    await assert.rejects(supervisor.stop(), /synthetic cleanup failure/);
    assert.equal(supervisor.getActiveRuntime().gameId, "late-exit");
    let launch = diagnostics.snapshot().launches[0];
    assert.equal(launch.failureReason, "cleanup");
    assert.match(launch.detail, /synthetic cleanup failure/);
    await waitUntil(() => supervisor.getActiveRuntime() === null);
    launch = diagnostics.snapshot().launches[0];
    assert.equal(launch.failureReason, "cleanup");
    assert.equal(launch.exit.code, 17);
    assert.match(launch.stdout.text, /fixture diagnostic stdout/);
  } finally { blocked = false; await supervisor.stop(); }
});

test("diagnostic files and output never appear in the public library or static routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-diagnostic-api-"));
  const diagnostics = new RuntimeDiagnostics({ writer: new FileDiagnosticWriter({ directory }) });
  const supervisor = new RuntimeSupervisor({ diagnostics, startupTimeoutMs: 5000, pollIntervalMs: 20 });
  const config = join(directory, "config.json");
  const registered = game("diagnostic-fixture");
  registered.root = directory;
  await writeFile(join(directory, "boardgame.json"), JSON.stringify(registered.manifest));
  await writeFile(config, JSON.stringify({ games: [{ path: directory }] }));
  const server = createNexusServer(config, { supervisor });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await supervisor.start(registered);
    await diagnostics.flush();
    const response = await fetch(`${origin}/api/games`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(JSON.parse(text).games[0].status, "running");
    assert.equal(JSON.parse(text).games[0].playUrl, "/games/diagnostic-fixture/");
    for (const forbidden of ["fixture diagnostic", "launchId", "stdout", "stderr", "runtime-diagnostics", directory]) assert.ok(!text.includes(forbidden));
    for (const path of ["/runtime-diagnostics.json", "/api/diagnostics", "/api/games/diagnostic-fixture/logs"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404);
    }
  } finally {
    await shutdownNexus(server, supervisor);
    await diagnostics.flush();
    await rm(directory, { recursive: true, force: true });
  }
});
