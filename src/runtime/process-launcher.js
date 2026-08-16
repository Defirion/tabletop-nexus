import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GAME_LAUNCH_SECURITY_BOUNDARY = Object.freeze({
  SAME_OS_IDENTITY: "same-os-identity",
  DISTINCT_SECURITY_BOUNDARY: "distinct-security-boundary",
});

const PROCESS_GROUP_POLL_MS = 20;
const LIFECYCLE_TOKEN_ENV = "NEXUS_LIFECYCLE_TOKEN";
const PROCESS_GROUP_HOST_PATH = fileURLToPath(new URL("./process-group-host.mjs", import.meta.url));

function assertLaunchableGame(game) {
  if (game === null || typeof game !== "object") {
    throw new TypeError("game must be an installed game object");
  }
  if (typeof game.root !== "string" || game.root.trim() === "") {
    throw new TypeError("game.root must be a non-empty string");
  }

  const runtime = game.manifest?.runtime;
  if (runtime === null || typeof runtime !== "object") {
    throw new TypeError("game.manifest.runtime must be an object");
  }
  if (typeof runtime.command !== "string" || runtime.command.trim() === "") {
    throw new TypeError("game.manifest.runtime.command must be a non-empty string");
  }
  if (!Array.isArray(runtime.args) || runtime.args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("game.manifest.runtime.args must be an array of strings");
  }
}

function copyEnvironment(environment) {
  if (environment === null || Array.isArray(environment) || typeof environment !== "object") {
    throw new TypeError("environment must be an object");
  }

  const copy = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") {
      throw new TypeError(`environment.${name} must be a string`);
    }
    copy[name] = value;
  }
  return Object.freeze(copy);
}

function createLaunchSpec(game, environment) {
  assertLaunchableGame(game);
  return Object.freeze({
    command: game.manifest.runtime.command,
    args: Object.freeze([...game.manifest.runtime.args]),
    cwd: game.root,
    environment: copyEnvironment(environment),
  });
}

function assertLauncher(launcher, { lifecycle = false } = {}) {
  if (launcher === null || typeof launcher !== "object") {
    throw new TypeError("launcher must be an object");
  }
  if (!Object.values(GAME_LAUNCH_SECURITY_BOUNDARY).includes(launcher.securityBoundary)) {
    throw new TypeError("launcher.securityBoundary must declare a supported game launch boundary");
  }
  if (typeof launcher.launch !== "function") {
    throw new TypeError("launcher.launch must be a function");
  }
  if (lifecycle && typeof launcher.waitForExit !== "function") {
    throw new TypeError("launcher.waitForExit must be a function for supervised runtimes");
  }
  if (lifecycle && typeof launcher.stop !== "function") {
    throw new TypeError("launcher.stop must be a function for supervised runtimes");
  }
}

function assertGracePeriod(gracePeriodMs) {
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new TypeError("gracePeriodMs must be a non-negative finite number");
  }
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function createSignalDeliveryError(signal, cause) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const error = new Error(
    `failed to deliver ${signal} to game process${detail}`,
    cause === undefined ? undefined : { cause },
  );
  error.code = "GAME_SIGNAL_DELIVERY_FAILED";
  error.signal = signal;
  return error;
}

function createProcessGroupInspectionError(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`failed to inspect game process group: ${detail}`, { cause });
  error.code = "GAME_PROCESS_GROUP_INSPECTION_FAILED";
  return error;
}

function createProcessGroupControllerError(cause) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const error = new Error(
    `game process-group controller exited before runtime termination was established${detail}`,
    cause === undefined ? undefined : { cause },
  );
  error.code = "GAME_PROCESS_GROUP_CONTROLLER_EXITED";
  return error;
}

function deserializeError(value) {
  if (value === null || typeof value !== "object") {
    return value === null ? null : new Error(String(value));
  }
  const error = new Error(typeof value.message === "string" ? value.message : "game process error");
  if (typeof value.code === "string") {
    error.code = value.code;
  }
  return error;
}

function readLinuxProcessMetadata(entry, readProcFile) {
  let stat;
  try {
    stat = readProcFile(`/proc/${entry}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return null;
    }
    throw createProcessGroupInspectionError(error);
  }

  const endName = stat.lastIndexOf(")");
  if (endName < 0) {
    throw createProcessGroupInspectionError(
      new Error(`malformed /proc/${entry}/stat process name`),
    );
  }
  const fields = stat.slice(endName + 2).trim().split(/\s+/);
  const state = fields[0];
  const processGroup = Number(fields[2]);
  if (typeof state !== "string" || state.length === 0 || !Number.isInteger(processGroup)) {
    throw createProcessGroupInspectionError(
      new Error(`malformed /proc/${entry}/stat process metadata`),
    );
  }

  return { pid: Number(entry), state, processGroup };
}

function processHasLifecycleToken(pid, lifecycleToken, readProcFile) {
  let environment;
  try {
    environment = readProcFile(`/proc/${pid}/environ`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return false;
    }
    throw createProcessGroupInspectionError(error);
  }

  const expected = `${LIFECYCLE_TOKEN_ENV}=${lifecycleToken}`;
  return environment.split("\0").includes(expected);
}

function linuxProcessGroupHasLiveMembers(
  processGroup,
  { readdirProc, readProcFile },
  { excludeController = false, ownedOnly = false } = {},
) {
  let entries;
  try {
    entries = readdirProc("/proc");
  } catch (error) {
    throw createProcessGroupInspectionError(error);
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    const metadata = readLinuxProcessMetadata(entry, readProcFile);
    if (metadata === null) {
      continue;
    }
    if (
      metadata.processGroup !== processGroup.id ||
      (excludeController && metadata.pid === processGroup.controllerPid) ||
      metadata.state === "Z" ||
      metadata.state === "X"
    ) {
      continue;
    }

    if (ownedOnly && !processHasLifecycleToken(metadata.pid, processGroup.lifecycleToken, readProcFile)) {
      continue;
    }
    return true;
  }

  return false;
}

function defaultProcessGroupExists(
  processGroup,
  { processKill, readdirProc, readProcFile },
  options = {},
) {
  if (process.platform === "linux") {
    return linuxProcessGroupHasLiveMembers(
      processGroup,
      { readdirProc, readProcFile },
      options,
    );
  }

  try {
    processKill(-processGroup.id, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw createProcessGroupInspectionError(error);
  }
}

function delay(ms, setTimeoutFn) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

async function waitForOwnedProcessGroupExit(processGroup, dependencies) {
  while (true) {
    try {
      if (!defaultProcessGroupExists(processGroup, dependencies, { ownedOnly: true })) {
        return;
      }
    } catch {
      // Inspection uncertainty is not exit evidence. Retain ownership until the
      // exact launch generation can be established as absent.
    }
    await delay(PROCESS_GROUP_POLL_MS, dependencies.setTimeoutFn);
  }
}

async function waitForHostedRuntimeMembersExit(processGroup, dependencies) {
  while (true) {
    try {
      if (!defaultProcessGroupExists(processGroup, dependencies, { excludeController: true })) {
        return;
      }
    } catch {
      // While the controller is alive its group id is still anchored, but an
      // inspection failure still cannot certify that the runtime members exited.
    }
    await delay(PROCESS_GROUP_POLL_MS, dependencies.setTimeoutFn);
  }
}

function sendRootSignal(child, signal) {
  if (childHasExited(child)) {
    return false;
  }

  try {
    if (child.kill(signal)) {
      return true;
    }
  } catch (error) {
    if (childHasExited(child)) {
      return false;
    }
    throw createSignalDeliveryError(signal, error);
  }

  if (childHasExited(child)) {
    return false;
  }
  throw createSignalDeliveryError(signal);
}

function trackDirectRuntimeExit(child) {
  return new Promise((resolve) => {
    let spawnError = null;
    const onError = (error) => {
      if (child.pid === undefined && spawnError === null) {
        spawnError = error;
      }
    };

    child.on("error", onError);
    child.once("close", (code, signal) => {
      child.off("error", onError);
      resolve(Object.freeze({ code, signal, error: spawnError }));
    });
  });
}

function createHostedRuntime(
  child,
  processGroup,
  dependencies,
  beforeGroupSignal,
  injectedGroupSignal,
) {
  let resolveExit;
  let settled = false;
  let rootExit = null;
  let controllerSpawnError = null;
  let cleanupError = null;
  let controllerClosed = false;
  let controllerClose = null;
  let controllerExitExpected = false;
  let requestId = 0;
  let operation = Promise.resolve();
  const control = { stopRequested: false };

  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function settle(result) {
    if (settled) {
      return;
    }
    settled = true;
    resolveExit(Object.freeze(result));
  }

  async function finalizeAfterControllerClose() {
    await waitForOwnedProcessGroupExit(processGroup, dependencies);
    const fallbackError = rootExit === null && cleanupError === null && !controllerExitExpected
      ? createProcessGroupControllerError(controllerSpawnError)
      : null;
    settle({
      code: rootExit !== null ? rootExit.code : (controllerClose?.code ?? null),
      signal: rootExit !== null ? rootExit.signal : (controllerClose?.signal ?? null),
      error: rootExit?.error ?? cleanupError ?? fallbackError,
    });
  }

  function queueOperation(action) {
    const queued = operation.then(action, action);
    operation = queued.catch(() => undefined);
    return queued;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      if (controllerClosed || typeof child.send !== "function" || child.connected === false) {
        reject(createProcessGroupControllerError());
        return;
      }
      child.send(message, (error) => {
        if (error) {
          reject(createProcessGroupControllerError(error));
          return;
        }
        resolve();
      });
    });
  }

  function requestGroupSignal(signal) {
    return new Promise(async (resolve, reject) => {
      try {
        await beforeGroupSignal(signal);
        if (injectedGroupSignal !== null) {
          injectedGroupSignal(-processGroup.id, signal);
          if (signal === "SIGKILL") {
            controllerExitExpected = true;
          }
          resolve(true);
          return;
        }
      } catch (error) {
        reject(createSignalDeliveryError(signal, error));
        return;
      }

      if (controllerClosed) {
        reject(createSignalDeliveryError(signal, createProcessGroupControllerError()));
        return;
      }

      const currentRequestId = ++requestId;
      const onMessage = (message) => {
        if (
          message === null ||
          typeof message !== "object" ||
          message.type !== "signal-result" ||
          message.requestId !== currentRequestId
        ) {
          return;
        }
        child.off("message", onMessage);
        child.off("close", onClose);
        if (message.ok === true) {
          if (signal === "SIGKILL") {
            controllerExitExpected = true;
          }
          resolve(true);
          return;
        }
        reject(createSignalDeliveryError(signal, deserializeError(message.error)));
      };
      const onClose = () => {
        child.off("message", onMessage);
        if (signal === "SIGKILL") {
          controllerExitExpected = true;
          resolve(true);
        } else {
          reject(createSignalDeliveryError(signal, createProcessGroupControllerError()));
        }
      };

      child.on("message", onMessage);
      child.once("close", onClose);
      try {
        await sendMessage({ type: "signal", signal, requestId: currentRequestId });
      } catch (error) {
        child.off("message", onMessage);
        child.off("close", onClose);
        reject(createSignalDeliveryError(signal, error));
      }
    });
  }

  async function releaseController() {
    if (controllerClosed) {
      return;
    }
    controllerExitExpected = true;
    try {
      await sendMessage({ type: "release" });
    } catch (error) {
      controllerExitExpected = false;
      throw error;
    }
  }

  async function cleanUnexpectedRuntime() {
    await queueOperation(async () => {
      while (!control.stopRequested && !controllerClosed) {
        let live;
        try {
          live = defaultProcessGroupExists(processGroup, dependencies, { excludeController: true });
        } catch {
          await delay(PROCESS_GROUP_POLL_MS, dependencies.setTimeoutFn);
          continue;
        }

        if (!live) {
          await releaseController();
          return;
        }

        try {
          await requestGroupSignal("SIGKILL");
          return;
        } catch (error) {
          cleanupError ??= error;
          await delay(PROCESS_GROUP_POLL_MS, dependencies.setTimeoutFn);
        }
      }
    });
  }

  child.on("error", (error) => {
    if (child.pid === undefined && controllerSpawnError === null) {
      controllerSpawnError = error;
    }
  });
  child.on("message", (message) => {
    if (message?.type !== "root-exit" || rootExit !== null) {
      return;
    }
    rootExit = {
      code: message.code ?? null,
      signal: message.signal ?? null,
      error: deserializeError(message.error),
    };
    if (!control.stopRequested) {
      void cleanUnexpectedRuntime();
    }
  });
  child.once("close", (code, signal) => {
    controllerClosed = true;
    controllerClose = { code, signal };
    void finalizeAfterControllerClose();
  });

  return {
    exit,
    processGroup,
    control,
    get rootExit() { return rootExit; },
    queueOperation,
    requestGroupSignal,
    releaseController,
    waitForMembersExit: () => waitForHostedRuntimeMembersExit(processGroup, dependencies),
  };
}

function createLocalProcessLauncher({
  spawn,
  parentEnv,
  captureOutput,
  ownProcessGroup,
  processKill,
  setTimeoutFn,
  clearTimeoutFn,
  readdirProc,
  readProcFile,
  createLifecycleToken,
  beforeGroupSignal,
}) {
  if (typeof spawn !== "function") {
    throw new TypeError("spawn must be a function");
  }
  if (parentEnv === null || Array.isArray(parentEnv) || typeof parentEnv !== "object") {
    throw new TypeError("parentEnv must be an object");
  }
  if (typeof processKill !== "function") {
    throw new TypeError("processKill must be a function");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("timer functions must be functions");
  }
  if (typeof readdirProc !== "function" || typeof readProcFile !== "function") {
    throw new TypeError("procfs functions must be functions");
  }
  if (typeof createLifecycleToken !== "function" || typeof beforeGroupSignal !== "function") {
    throw new TypeError("lifecycle hooks must be functions");
  }

  const runtimes = new WeakMap();
  const dependencies = {
    processKill,
    setTimeoutFn,
    clearTimeoutFn,
    readdirProc,
    readProcFile,
  };

  return Object.freeze({
    securityBoundary: GAME_LAUNCH_SECURITY_BOUNDARY.SAME_OS_IDENTITY,
    launch(spec) {
      if (ownProcessGroup) {
        const lifecycleToken = createLifecycleToken();
        if (typeof lifecycleToken !== "string" || lifecycleToken.length === 0) {
          throw new TypeError("createLifecycleToken must return a non-empty string");
        }
        const environment = {
          ...parentEnv,
          ...spec.environment,
          [LIFECYCLE_TOKEN_ENV]: lifecycleToken,
        };
        const hostSpec = JSON.stringify({
          command: spec.command,
          args: [...spec.args],
          cwd: spec.cwd,
        });
        const child = spawn(process.execPath, [PROCESS_GROUP_HOST_PATH, hostSpec], {
          cwd: spec.cwd,
          shell: false,
          env: environment,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: true,
        });
        const processGroup = Number.isInteger(child.pid)
          ? Object.freeze({
            id: child.pid,
            controllerPid: child.pid,
            lifecycleToken,
          })
          : null;
        if (processGroup === null) {
          const exit = trackDirectRuntimeExit(child);
          runtimes.set(child, { exit, processGroup: null, control: { stopRequested: false } });
        } else {
          runtimes.set(
            child,
            createHostedRuntime(
              child,
              processGroup,
              dependencies,
              beforeGroupSignal,
              processKill === process.kill ? null : processKill,
            ),
          );
        }
        return child;
      }

      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        shell: false,
        env: { ...parentEnv, ...spec.environment },
        stdio: captureOutput
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "ignore", "ignore"],
      });
      const exit = trackDirectRuntimeExit(child);
      runtimes.set(child, { exit, processGroup: null, control: { stopRequested: false } });
      return child;
    },
    waitForExit(child) {
      const runtime = runtimes.get(child);
      if (runtime === undefined) {
        throw new TypeError("unknown local game process handle");
      }
      return runtime.exit;
    },
    async stop(child, { gracePeriodMs = 5_000 } = {}) {
      assertGracePeriod(gracePeriodMs);
      const runtime = runtimes.get(child);
      if (runtime === undefined) {
        throw new TypeError("unknown local game process handle");
      }

      runtime.control.stopRequested = true;
      if (runtime.processGroup === null) {
        if (childHasExited(child)) {
          return Object.freeze({ ...(await runtime.exit), forced: false });
        }

        const gracefulSignalDelivered = sendRootSignal(child, "SIGTERM");
        if (!gracefulSignalDelivered) {
          return Object.freeze({ ...(await runtime.exit), forced: false });
        }

        let timeoutId;
        const gracefulTimeout = new Promise((resolve) => {
          timeoutId = setTimeoutFn(() => resolve(null), gracePeriodMs);
        });
        const gracefulExit = await Promise.race([runtime.exit, gracefulTimeout]);
        if (gracefulExit !== null) {
          clearTimeoutFn(timeoutId);
          return Object.freeze({ ...gracefulExit, forced: false });
        }

        const forcedSignalDelivered = sendRootSignal(child, "SIGKILL");
        if (!forcedSignalDelivered) {
          return Object.freeze({ ...(await runtime.exit), forced: false });
        }
        return Object.freeze({ ...(await runtime.exit), forced: true });
      }

      return runtime.queueOperation(async () => {
        if (childHasExited(child)) {
          return Object.freeze({ ...(await runtime.exit), forced: false });
        }

        const live = defaultProcessGroupExists(runtime.processGroup, dependencies, {
          excludeController: true,
        });
        if (!live) {
          await runtime.releaseController();
          return Object.freeze({ ...(await runtime.exit), forced: false });
        }

        if (runtime.rootExit !== null) {
          await runtime.requestGroupSignal("SIGKILL");
          return Object.freeze({ ...(await runtime.exit), forced: true });
        }

        await runtime.requestGroupSignal("SIGTERM");
        let timeoutId;
        const gracefulTimeout = new Promise((resolve) => {
          timeoutId = setTimeoutFn(() => resolve(false), gracePeriodMs);
        });
        const gracefulExit = runtime.waitForMembersExit().then(() => true);
        const graceful = await Promise.race([gracefulExit, gracefulTimeout]);
        if (graceful) {
          clearTimeoutFn(timeoutId);
          await runtime.releaseController();
          return Object.freeze({ ...(await runtime.exit), forced: false });
        }

        await runtime.requestGroupSignal("SIGKILL");
        return Object.freeze({ ...(await runtime.exit), forced: true });
      });
    },
  });
}

export function createLocalGameProcessLauncher({
  spawn = nodeSpawn,
  parentEnv = process.env,
  processKill = process.kill,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  readdirProc = readdirSync,
  readProcFile = readFileSync,
  createLifecycleToken = () => randomBytes(32).toString("hex"),
  beforeGroupSignal = () => undefined,
  ownProcessGroup = process.platform === "linux" && (spawn === nodeSpawn || processKill !== process.kill),
} = {}) {
  return createLocalProcessLauncher({
    spawn,
    parentEnv,
    captureOutput: false,
    ownProcessGroup,
    processKill,
    setTimeoutFn,
    clearTimeoutFn,
    readdirProc,
    readProcFile,
    createLifecycleToken,
    beforeGroupSignal,
  });
}

/**
 * Launches one validated game through an explicit execution mechanism.
 *
 * The launcher receives only an immutable executable/argument/cwd/environment
 * specification rather than the installed-game object. The environment contains
 * Nexus-owned launch variables such as HOST, PORT, BASE_PATH, and the private
 * readiness association token; a local launcher merges them over its inherited
 * environment at the child-process boundary.
 */
export function launchGameProcess(
  game,
  { launcher, environment = {}, requireDistinctSecurityBoundary = false } = {},
) {
  if (typeof requireDistinctSecurityBoundary !== "boolean") {
    throw new TypeError("requireDistinctSecurityBoundary must be a boolean");
  }
  assertLauncher(launcher);

  if (
    requireDistinctSecurityBoundary &&
    launcher.securityBoundary !== GAME_LAUNCH_SECURITY_BOUNDARY.DISTINCT_SECURITY_BOUNDARY
  ) {
    throw new Error("game launch requires a distinct security identity or sandbox boundary");
  }

  return launcher.launch(createLaunchSpec(game, environment));
}

/**
 * Creates the supervisor-facing lifecycle wrapper around an opaque launcher handle.
 * Supervisor code can wait and stop without depending on Node ChildProcess shape.
 */
export function launchSupervisedGameProcess(
  game,
  { launcher, environment = {}, requireDistinctSecurityBoundary = false } = {},
) {
  assertLauncher(launcher, { lifecycle: true });
  const handle = launchGameProcess(game, {
    launcher,
    environment,
    requireDistinctSecurityBoundary,
  });

  return Object.freeze({
    securityBoundary: launcher.securityBoundary,
    waitForExit: () => launcher.waitForExit(handle),
    stop: (options) => launcher.stop(handle, options),
  });
}

/**
 * Launches one validated game directly for the local/LAN runtime profile.
 *
 * Direct callers receive the ChildProcess, so stdout/stderr remain piped for the
 * caller to consume. The supervisor-capable exported local launcher always uses
 * discarded output instead, avoiding an unowned pipe/backpressure dependency.
 */
export function launchLocalGameProcess(
  game,
  { spawn = nodeSpawn, parentEnv = process.env, environment = {} } = {},
) {
  return launchGameProcess(game, {
    launcher: createLocalProcessLauncher({
      spawn,
      parentEnv,
      captureOutput: true,
      ownProcessGroup: false,
      processKill: process.kill,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      readdirProc: readdirSync,
      readProcFile: readFileSync,
      createLifecycleToken: () => randomBytes(32).toString("hex"),
      beforeGroupSignal: () => undefined,
    }),
    environment,
  });
}
