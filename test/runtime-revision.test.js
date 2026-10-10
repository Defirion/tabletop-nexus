import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { MemoryOwnershipJournal } from "../src/runtime/ownership-journal.js";

test("recovered runtime revisions are fresh opaque values across Nexus restarts", async () => {
  const journal = new MemoryOwnershipJournal();
  journal.write({ gameId: "game-a", privatePort: 45678, phase: "running",
    launchedAt: new Date().toISOString(), ownership: { kind: "test", generation: "private-identity" } });
  let present = true;
  const launcher = { inspectRecovery: () => present
    ? { state: "present", controllerLive: false } : { state: "absent" } };
  const first = new RuntimeSupervisor({ journal, launcher, recoveryPollMs: 10 });
  const second = new RuntimeSupervisor({ journal, launcher, recoveryPollMs: 10 });
  try {
    await first.recover();
    await second.recover();
    const a = first.getActiveRuntime().revision;
    const b = second.getActiveRuntime().revision;
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
    await assert.rejects(second.stop("game-a", { gameId: "game-a", revision: a }), { code: "RUNTIME_CHANGED" });
    assert.equal(second.getActiveRuntime().revision, b);
  } finally {
    present = false;
    await first.stop();
    await second.stop();
  }
});
