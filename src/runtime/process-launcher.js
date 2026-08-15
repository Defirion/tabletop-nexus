import { spawn as nodeSpawn } from "node:child_process";

export const GAME_LAUNCH_SECURITY_BOUNDARY = Object.freeze({
  SAME_OS_IDENTITY: "same-os-identity",
  DISTINCT_SECURITY_BOUNDARY: "distinct-security-boundary",
});

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

function sendSignal(child, signal) {
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

function trackChildExit(child) {
  return new Promise((resolve) => {
    let spawnError = null;
    const onError = (error) => {
      // ChildProcess 'error' also covers failed kill/message operations after a
      // successful spawn. Those are lifecycle errors, not proof of termination.
      // A missing pid is the Node-documented spawn-failure case; 'close' still
      // follows and is the definitive point at which no child can remain alive.
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

export function createLocalGameProcessLauncher({
  spawn = nodeSpawn,
  parentEnv = process.env,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof spawn !== "function") {
    throw new TypeError("spawn must be a function");
  }
  if (parentEnv === null || Array.isArray(parentEnv) || typeof parentEnv !== "object") {
    throw new TypeError("parentEnv must be an object");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("timer functions must be functions");
  }

  const exits = new WeakMap();

  return Object.freeze({
    securityBoundary: GAME_LAUNCH_SECURITY_BOUNDARY.SAME_OS_IDENTITY,
    launch(spec) {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        shell: false,
        env: { ...parentEnv, ...spec.environment },
      });
      exits.set(child, trackChildExit(child));
      return child;
    },
    waitForExit(child) {
      const exit = exits.get(child);
      if (exit === undefined) {
        throw new TypeError("unknown local game process handle");
      }
      return exit;
    },
    async stop(child, { gracePeriodMs = 5_000 } = {}) {
      assertGracePeriod(gracePeriodMs);
      const exit = exits.get(child);
      if (exit === undefined) {
        throw new TypeError("unknown local game process handle");
      }

      if (childHasExited(child)) {
        return Object.freeze({ ...(await exit), forced: false });
      }

      const gracefulSignalDelivered = sendSignal(child, "SIGTERM");
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

      const forcedSignalDelivered = sendSignal(child, "SIGKILL");
      if (!forcedSignalDelivered) {
        return Object.freeze({ ...(await exit), forced: false });
      }
      return Object.freeze({ ...(await exit), forced: true });
    },
  });
}

/**
 * Launches one validated game through an explicit execution mechanism.
 *
 * The launcher receives only an immutable executable/argument/cwd/environment
 * specification rather than the installed-game object. The environment contains
 * Nexus-owned launch variables such as HOST, PORT, and BASE_PATH; a local launcher
 * merges them over its inherited environment at the child-process boundary.
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
 */
export function launchLocalGameProcess(
  game,
  { spawn = nodeSpawn, parentEnv = process.env, environment = {} } = {},
) {
  return launchGameProcess(game, {
    launcher: createLocalGameProcessLauncher({ spawn, parentEnv }),
    environment,
  });
}
