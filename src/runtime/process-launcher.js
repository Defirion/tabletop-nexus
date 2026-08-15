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

function createLaunchSpec(game) {
  assertLaunchableGame(game);
  return Object.freeze({
    command: game.manifest.runtime.command,
    args: Object.freeze([...game.manifest.runtime.args]),
    cwd: game.root,
  });
}

function assertLauncher(launcher) {
  if (launcher === null || typeof launcher !== "object") {
    throw new TypeError("launcher must be an object");
  }
  if (!Object.values(GAME_LAUNCH_SECURITY_BOUNDARY).includes(launcher.securityBoundary)) {
    throw new TypeError("launcher.securityBoundary must declare a supported game launch boundary");
  }
  if (typeof launcher.launch !== "function") {
    throw new TypeError("launcher.launch must be a function");
  }
}

export function createLocalGameProcessLauncher({ spawn = nodeSpawn } = {}) {
  if (typeof spawn !== "function") {
    throw new TypeError("spawn must be a function");
  }

  return Object.freeze({
    securityBoundary: GAME_LAUNCH_SECURITY_BOUNDARY.SAME_OS_IDENTITY,
    launch(spec) {
      return spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        shell: false,
      });
    },
  });
}

/**
 * Launches one validated game through an explicit execution mechanism.
 *
 * The launcher receives only an immutable executable/argument/cwd spec rather
 * than the installed-game object. This keeps future service-manager/sandbox
 * implementations independent from game metadata and prevents supervisor code
 * from assuming the returned handle is necessarily a Node ChildProcess.
 *
 * `requireDistinctSecurityBoundary` is the fail-closed switch for deployment
 * profiles that may expose games to hostile player traffic. A same-identity
 * local launcher is rejected before launch when that stronger boundary is
 * required. The launcher declaration is trusted implementation metadata; the
 * deployment profile still has to verify that its isolated mechanism actually
 * enforces the documented security properties.
 */
export function launchGameProcess(
  game,
  { launcher, requireDistinctSecurityBoundary = false } = {},
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

  return launcher.launch(createLaunchSpec(game));
}

/**
 * Launches one validated game directly for the local/LAN runtime profile.
 *
 * The executable and argument vector remain separate all the way to Node's
 * child-process boundary. `shell: false` is explicit so manifest text can never
 * acquire shell syntax through this launcher. This mechanism deliberately
 * declares a same-OS-identity boundary and is not sufficient for supported
 * remote play by itself.
 */
export function launchLocalGameProcess(game, { spawn = nodeSpawn } = {}) {
  return launchGameProcess(game, {
    launcher: createLocalGameProcessLauncher({ spawn }),
  });
}
