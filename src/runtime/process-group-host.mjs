import { spawn } from "node:child_process";

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

let rootClosed = false;
let releaseRequested = false;
let spawnError = null;

// The controller is the stable group leader. It deliberately survives graceful
// group termination so the group identifier cannot be recycled while Nexus is
// still deciding whether runtime-owned members remain.
process.on("SIGTERM", () => {});

const root = spawn(launchSpec.command, launchSpec.args, {
  cwd: launchSpec.cwd,
  shell: false,
  env: process.env,
  stdio: ["ignore", "ignore", "ignore"],
});

root.on("error", (error) => {
  if (root.pid === undefined && spawnError === null) {
    spawnError = error;
  }
});

root.once("close", (code, signal) => {
  rootClosed = true;
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

process.on("message", (message) => {
  if (message === null || typeof message !== "object") {
    return;
  }

  if (message.type === "release") {
    if (rootClosed) {
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
