// Stands in for a Nexus process in restart-recovery tests: it supervises one
// fixture game with the real launcher and journal, reports readiness on stdout,
// and then waits to be killed by the test.
//
//   node nexus-harness.mjs <stateDir> [fixture game arguments...]
//
// HARNESS_DIE_AFTER_RECORD=1 makes it kill itself the moment the runtime's
// ownership has been recorded, before the runtime is told to start.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FileOwnershipJournal } from "../src/runtime/ownership-journal.js";
import { createLocalGameProcessLauncher } from "../src/runtime/process-launcher.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "runtime-game");
const [stateDir, ...gameArgs] = process.argv.slice(2);

const real = createLocalGameProcessLauncher({ orphanGracePeriodMs: 300 });
const launcher = process.env.HARNESS_DIE_AFTER_RECORD === "1"
  ? {
    ...real,
    launch: (spec, options) => real.launch(spec, {
      recordOwnership(ownership) {
        options.recordOwnership(ownership);
        process.kill(process.pid, "SIGKILL");
      },
    }),
  }
  : real;

const supervisor = new RuntimeSupervisor({
  launcher,
  journal: new FileOwnershipJournal({ directory: stateDir }),
  startupTimeoutMs: 5_000,
  pollIntervalMs: 20,
  requestTimeoutMs: 200,
  stopGracePeriodMs: 200,
});

await supervisor.start({
  root: fixtureRoot,
  manifest: {
    id: "harness-game",
    runtime: { command: process.execPath, args: [join(fixtureRoot, "server.mjs"), ...gameArgs] },
  },
});
const { host, port } = supervisor.getActiveRuntime();
console.log(JSON.stringify({ ready: true, host, port }));
setInterval(() => {}, 1_000);
