import { spawn as nodeSpawn } from "node:child_process";

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

/**
 * Launches one validated game directly for the local/LAN runtime profile.
 *
 * The executable and argument vector remain separate all the way to Node's
 * child-process boundary. `shell: false` is explicit so manifest text can never
 * acquire shell syntax through this launcher. The returned ChildProcess is left
 * to the later supervisor lifecycle work.
 */
export function launchLocalGameProcess(game, { spawn = nodeSpawn } = {}) {
  if (typeof spawn !== "function") {
    throw new TypeError("spawn must be a function");
  }
  assertLaunchableGame(game);

  const { runtime } = game.manifest;
  return spawn(runtime.command, [...runtime.args], {
    cwd: game.root,
    shell: false,
  });
}
