import { spawn } from "node:child_process";

const DEFAULT_ORPHAN_GRACE_MS = 5_000;

function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  return {
    message: error.message,
    code: typeof error.code === "string" ? error.code : undefined,
  };
}

function send(message, callback = undefined) {
  if (!process.connected) {
    callback?.();
    return;
  }
  process.send(message, callback);
}

let launchSpec;
try {
  launchSpec = JSON.parse(process.argv[2]);
} catch (error) {
  send({ type: "root-exit", code: null, signal: null, error: serializeError(error) }, () => {
    process.exit(1);
  });
  await new Promise(() => {});
}

const requestedGrace = Number(process.argv[3]);
const orphanGraceMs = Number.isFinite(requestedGrace) && requestedGrace >= 0
  ? requestedGrace
  : DEFAULT_ORPHAN_GRACE_MS;

let root = null;
let rootClosed = false;
let releaseRequested = false;
let reaping = false;
let spawnError = null;

// The controller is the stable group leader. It deliberately survives graceful
// group termination so the group identifier cannot be recycled while Nexus is
// still deciding whether runtime-owned members remain.
process.on("SIGTERM", () => {});

// The runtime is not launched until Nexus has durably recorded this controller's
// identity and acknowledged with a "start" message. A controller that loses
// Nexus before then has launched nothing and simply exits.
function startRoot() {
  if (root !== null) {
    return;
  }
  root = spawn(launchSpec.command, launchSpec.args, {
    cwd: launchSpec.cwd,
    shell: false,
    env: process.env,
    // Inherit the controller's output descriptors directly. Nexus consumes them
    // when diagnostics are enabled; otherwise they point to the null device.
    // No output is queued on the lifecycle IPC channel.
    stdio: ["ignore", 1, 2],
  });

  root.on("error", (error) => {
    if (root.pid === undefined && spawnError === null) {
      spawnError = error;
    }
  });

  root.once("close", (code, signal) => {
    rootClosed = true;
    if (reaping) {
      // Nexus is gone and nothing remains to report to. Any runtime-owned
      // residue is removed from inside the still-owned group; this also ends us.
      process.kill(0, "SIGKILL");
      return;
    }
    send({
      type: "root-exit",
      code,
      signal,
      error: spawnError === null ? null : serializeError(spawnError),
    }, () => {
      if (releaseRequested) {
        process.exit(0);
      }
    });
  });
}

// Nexus owns this controller through the IPC channel. If the channel closes
// without an orderly release, Nexus crashed or was killed: a runtime nobody can
// supervise must not outlive it. Cleanup is performed here, from inside the
// owned group, so no outside process ever signals a recycled group identifier.
function reapOrphanedRuntime() {
  if (root === null) {
    process.exit(0);
  }
  if (reaping) {
    return;
  }
  reaping = true;
  if (rootClosed) {
    process.kill(0, "SIGKILL");
    return;
  }
  try {
    process.kill(0, "SIGTERM");
  } catch {
    process.kill(0, "SIGKILL");
    return;
  }
  // The timer keeps this process alive until the group is forcibly removed.
  setTimeout(() => process.kill(0, "SIGKILL"), orphanGraceMs);
}

process.on("disconnect", reapOrphanedRuntime);

process.on("message", (message) => {
  if (message === null || typeof message !== "object") {
    return;
  }

  if (message.type === "start") {
    startRoot();
    return;
  }

  if (message.type === "release") {
    if (root === null || rootClosed) {
      process.exit(0);
    } else {
      releaseRequested = true;
    }
    return;
  }

  if (message.type !== "signal" || typeof message.signal !== "string") {
    return;
  }

  const requestId = message.requestId;
  if (message.signal === "SIGKILL") {
    // A process in the owned group performs the destructive group signal. At the
    // syscall boundary the group therefore cannot have been recycled to another
    // generation. The acknowledgement is sent before the uncatchable signal.
    send({ type: "signal-result", requestId, ok: true }, () => {
      process.kill(0, "SIGKILL");
    });
    return;
  }

  try {
    process.kill(0, message.signal);
    send({ type: "signal-result", requestId, ok: true });
  } catch (error) {
    send({
      type: "signal-result",
      requestId,
      ok: false,
      error: serializeError(error),
    });
  }
});
