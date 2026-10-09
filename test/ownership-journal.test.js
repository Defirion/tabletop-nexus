import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileOwnershipJournal,
  MemoryOwnershipJournal,
  OWNERSHIP_JOURNAL_FILE,
  defaultStateDirectory,
} from "../src/runtime/ownership-journal.js";

const posix = process.platform !== "win32";

const entry = Object.freeze({
  gameId: "game-a",
  privatePort: 40123,
  phase: "launching",
  launchedAt: "2026-10-09T10:00:00.000Z",
  ownership: Object.freeze({ kind: "linux-process-group", lifecycleToken: "t", processGroupId: 4242, controllerPid: 4242 }),
});

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "nexus-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

test("an absent record reads as empty and clearing it is harmless", async (t) => {
  const journal = new FileOwnershipJournal({ directory: await directory(t) });
  assert.deepEqual(journal.read(), { status: "empty" });
  journal.clear();
  assert.deepEqual(journal.read(), { status: "empty" });
});

test("a written record round-trips, is replaced atomically and leaves no temporary file", async (t) => {
  const state = await directory(t);
  const journal = new FileOwnershipJournal({ directory: state });
  journal.write(entry);
  assert.deepEqual(journal.read().entry, { ...entry, version: 1 });

  journal.write({ ...entry, phase: "running" });
  assert.equal(journal.read().entry.phase, "running");
  assert.deepEqual(await readdir(state), [OWNERSHIP_JOURNAL_FILE]);

  journal.clear();
  assert.deepEqual(journal.read(), { status: "empty" });
});

test("a record is private to its owner", { skip: !posix }, async (t) => {
  const state = await directory(t);
  const journal = new FileOwnershipJournal({ directory: state });
  journal.write(entry);
  assert.equal((await stat(journal.path)).mode & 0o077, 0);
  assert.equal((await stat(state)).mode & 0o077, 0);
});

test("a state directory other users could reach is refused rather than trusted", { skip: !posix }, async (t) => {
  const state = await directory(t);
  await mkdir(state, { recursive: true });
  await chmod(state, 0o755);
  assert.throws(() => new FileOwnershipJournal({ directory: state }).write(entry), /must not be accessible/);
});

test("a symlinked state directory is refused", { skip: !posix }, async (t) => {
  const state = await directory(t);
  const target = `${state}-target`;
  await mkdir(target, { recursive: true, mode: 0o700 });
  t.after(() => rm(target, { recursive: true, force: true }));
  await symlink(target, state);
  assert.throws(() => new FileOwnershipJournal({ directory: state }).write(entry), /not a real directory/);
});

test("damaged, foreign or non-file records read as unreadable, never as empty", async (t) => {
  const state = await directory(t);
  await mkdir(state, { recursive: true });
  const journal = new FileOwnershipJournal({ directory: state });
  const path = join(state, OWNERSHIP_JOURNAL_FILE);

  await writeFile(path, "{ not json");
  assert.equal(journal.read().status, "unreadable");

  await writeFile(path, JSON.stringify({ ...entry, version: 99 }));
  assert.equal(journal.read().status, "unreadable");

  await writeFile(path, JSON.stringify({ version: 1, gameId: "game-a" }));
  assert.equal(journal.read().status, "unreadable");

  await writeFile(path, JSON.stringify(null));
  assert.equal(journal.read().status, "unreadable");

  await rm(path);
  await mkdir(path);
  assert.equal(journal.read().status, "unreadable");
});

test("an invalid entry is rejected before anything is written", async (t) => {
  const journal = new FileOwnershipJournal({ directory: await directory(t) });
  assert.throws(() => journal.write({ ...entry, gameId: "" }), TypeError);
  assert.throws(() => journal.write({ ...entry, privatePort: 0 }), TypeError);
  assert.throws(() => journal.write({ ...entry, ownership: null }), TypeError);
  assert.deepEqual(journal.read(), { status: "empty" });
});

test("the default state directory honours NEXUS_STATE_DIR and is otherwise per-user", () => {
  assert.equal(defaultStateDirectory({ NEXUS_STATE_DIR: "/var/lib/nexus" }), "/var/lib/nexus");
  const fallback = defaultStateDirectory({});
  assert.ok(fallback.startsWith(tmpdir()));
  assert.match(fallback, /tabletop-nexus-/);
});

test("the in-memory journal follows the same contract", () => {
  const journal = new MemoryOwnershipJournal();
  assert.deepEqual(journal.read(), { status: "empty" });
  journal.write(entry);
  const stored = journal.read();
  assert.equal(stored.status, "entry");
  stored.entry.gameId = "mutated";
  assert.equal(journal.read().entry.gameId, "game-a", "readers cannot alter the stored record");
  journal.corrupt();
  assert.equal(journal.read().status, "unreadable");
  journal.clear();
  assert.deepEqual(journal.read(), { status: "empty" });
  assert.throws(() => journal.write({ ...entry, phase: 3 }), TypeError);
});
