import { spawn as nodeSpawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export const GAME_LAUNCH_SECURITY_BOUNDARY = Object.freeze({
  SAME_OS_IDENTITY: "same-os-identity",
  DISTINCT_SECURITY_BOUNDARY: "distinct-security-boundary",
});

const PROCESS_GROUP_POLL_MS = 20;

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

function linuxProcessGroupHasLiveMembers(processGroupId) {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    throw createProcessGroupInspectionError(error);
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") {
        continue;
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

    // Zombies have already relinquished listeners and other runtime resources;
    // waiting for their eventual parent reaping would turn graceful shutdown into
    // a false forced-stop result without strengthening the ownership boundary.
    if (processGroup === processGroupId && state !== "Z" && state !== "X") {
      return true;
    }
  }

  return false;
}

function defaultProcessGroupExists(processGroupId, processKill) {
  if (process.platform === "linux") {
    return linuxProcessGroupHasLiveMembers(processGroupId);
  }

  try {
    processKill(-processGroupId, 0);
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

async function waitForProcessGroupExit(processGroupId, { processKill, setTimeoutFn }) {
  while (true) {
    try {
      if (!defaultProcessGroupExists(processGroupId, processKill)) {
        return;
      }
    } catch {
      // An inspection failure is not evidence that the runtime is gone. Retain
      // ownership and retry until group termination can actually be established.
    }
    await delay(PROCESS_GROUP_POLL_MS, setTimeoutFn);
  }
}

async function cleanUnexpectedProcessGroup(
  processGroupId,
  control,
  { processKill, setTimeoutFn },
) {
  let cleanupError = null;

  // The manifest-launched root is required to remain attached to the runtime.
  // If it exits without a requested stop, any surviving group members are orphaned
  // runtime residue and must be terminated before waitForExit can settle.
  while (!control.stopRequested) {
    let live;
    try {
      live = defaultProcessGroupExists(processGroupId, processKill);
    } catch {
      await delay(PROCESS_GROUP_POLL_MS, setTimeoutFn);
      continue;
    }
    if (!live) {
      return cleanupError;
    }

    try {
      processKill(-processGroupId, "SIGKILL");
      break;
    } catch (error) {
      if (error?.code === "ESRCH") {
        break;
      }
      cleanupError ??= createSignalDeliveryError("SIGKILL", error);
      await delay(PROCESS_GROUP_POLL_MS, setTimeoutFn);
    }
  }

  await waitForProcessGroupExit(processGroupId, {
    processKill,
    setTimeoutFn,
  });
  return cleanupError;
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

function sendSignal(child, processGroupId, signal, processKill) {
  if (processGroupId === null) {
    return sendRootSignal(child, signal);
  }

  try {
    processKill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw createSignalDeliveryError(signal, error);
    }
  }

  // A real detached Unix root is its process-group leader, so a live root with
  // no matching group is an anomalous/fake-handle case. Falling back to the root
  // keeps that case fail-closed without delivering every normal signal twice.
  return sendRootSignal(child, signal);
}

function trackRuntimeExit(
  child,
  { processGroupId, control, processKill, setTimeoutFn },
) {
  return new Promise((resolve) => {
    let spawnError = null;
    const onError = (error) => {
      // ChildProcess 'error' also covers failed kill/message operations after a
      // successful spawn. Those are lifecycle errors, not proof of termination.
      // A missing pid is the Node-documented spawn-failure case; 'close' still
      // follows and is the definitive point at which no root child remains alive.
      if (child.pid === undefined && spawnError === null) {
        spawnError = error;
      }
    };

    child.on("error", onError);
    child.once("close", async (code, signal) => {
      child.off("error", onError);
      let cleanupError = null;
      if (processGroupId !== null) {
        cleanupError = await cleanUnexpectedProcessGroup(processGroupId, control, {
          processKill,
          setTimeoutFn,
        });
      }
      resolve(Object.freeze({ code, signal, error: spawnError ?? cleanupError }));
    });
  });
}

function createLocalProcessLauncher({
  spawn,
  parentEnv,
  captureOutput,
  ownProcessGroup,
  processKill,
  setTimeoutFn,
  clearTimeoutFn,
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

  const runtimes = new WeakMap();

  return Object.freeze({
    securityBoundary: GAME_LAUNCH_SECURITY_BOUNDARY.SAME_OS_IDENTITY,
    launch(spec) {
      const spawnOptions = {
        cwd: spec.cwd,
        shell: false,
        env: { ...parentEnv, ...spec.environment },
        // Supervisor launchers never leave hidden stdout/stderr pipes with no
        // consumer. The direct helper uses the private capturing variant below
        // because it returns the ChildProcess to the caller that owns the pipes.
        stdio: captureOutput
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "ignore", "ignore"],
      };
      if (ownProcessGroup) {
        // On Unix, detached children become leaders of a new process group/session.
        // The supervised launcher owns that group so ordinary runtime descendants
        // cannot outlive the root and retain Nexus-assigned resources unnoticed.
        spawnOptions.detached = true;
      }
      const child = spawn(spec.command, [...spec.args], spawnOptions);
      const processGroupId = ownProcessGroup && Number.isInteger(child.pid)
        ? child.pid
        : null;
      const control = { stopRequested: false };
      const exit = trackRuntimeExit(child, {
        processGroupId,
        control,
        processKill,
        setTimeoutFn,
      });
      runtimes.set(child, { exit, processGroupId, control });
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

      const { exit, processGroupId, control } = runtime;
      control.stopRequested = true;

      const runtimeAlive = !childHasExited(child) || (
        processGroupId !== null && defaultProcessGroupExists(processGroupId, processKill)
      );
      if (!runtimeAlive) {
        return Object.freeze({ ...(await exit), forced: false });
      }

      const gracefulSignalDelivered = sendSignal(child, processGroupId, "SIGTERM", processKill);
      if (!gracefulSignalDelivered) {
        return Object.freeze({ ...(await exit), forced: false });
      }

      let timeoutId;
      const gracefulTimeout = new Promise((resolve) => {
        timeoutId = setTimeoutFn(() => resolve(null), gracePeriodMs);
      });
      const gracefulExit = await Promise.race([exit, gracefulTimeout]);
      if (gracefulExit !== null) {
        clearTimeoutFn(timeoutId);
        return Object.freeze({ ...gracefulExit, forced: false });
      }

      const forcedSignalDelivered = sendSignal(child, processGroupId, "SIGKILL", processKill);
      if (!forcedSignalDelivered) {
        return Object.freeze({ ...(await exit), forced: false });
      }
      return Object.freeze({ ...(await exit), forced: true });
    },
  });
}

export function createLocalGameProcessLauncher({
  spawn = nodeSpawn,
  parentEnv = process.env,
  processKill = process.kill,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  return createLocalProcessLauncher({
    spawn,
    parentEnv,
    captureOutput: false,
    ownProcessGroup: process.platform !== "win32",
    processKill,
    setTimeoutFn,
    clearTimeoutFn,
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
    }),
    environment,
  });
}
