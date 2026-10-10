import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Runs only in the disposable installer container, against its writable game
// mount. The long-lived Nexus container never installs or builds games.
export function installGame({ cwd = process.cwd(), run = execFileSync } = {}) {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const npmLock = existsSync(join(cwd, "package-lock.json"));
  const pnpmLock = existsSync(join(cwd, "pnpm-lock.yaml"));
  const manager = pkg.packageManager;
  const pnpmVersion = typeof manager === "string" && /^pnpm@(\d+\.\d+\.\d+)$/.exec(manager)?.[1];
  if (manager && !pnpmVersion && !/^npm@\d+\.\d+\.\d+$/.test(manager)) {
    throw new Error("Unsupported packageManager; use npm or an exact pnpm@X.Y.Z version");
  }
  if (pnpmVersion ? !pnpmLock : !npmLock || (!manager && pnpmLock)) {
    throw new Error(pnpmVersion
      ? "Commit pnpm-lock.yaml for reproducible installs"
      : "Commit package-lock.json for npm, or select pnpm@X.Y.Z with pnpm-lock.yaml");
  }
  const env = { ...process.env, CI: "true" };
  const options = { cwd, env, stdio: "inherit" };
  const build = typeof pkg.scripts?.build === "string";
  if (!pnpmVersion) {
    run("npm", ["ci", build ? "--include=dev" : "--omit=dev", "--no-audit", "--no-fund"], options);
    if (build) {
      run("npm", ["run", "build"], options);
      run("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], options);
    }
    return;
  }
  // Bootstrap the game's exact package-manager version in /tmp, without
  // Corepack signature/version drift or a global install in the runtime image.
  const managerRoot = mkdtempSync(join(tmpdir(), "nexus-pnpm-"));
  try {
    run("npm", ["install", "--prefix", managerRoot, "--ignore-scripts", "--no-audit", "--no-fund", `pnpm@${pnpmVersion}`], options);
    const executable = join(managerRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
    const pnpm = (args) => run(process.execPath, [executable, ...args], options);
    pnpm(["install", "--frozen-lockfile", build ? "--prod=false" : "--prod"]);
    if (build) {
      pnpm(["run", "build"]);
      // install --prod also removes dev dependencies across pnpm workspaces;
      // prune does not support recursive workspace pruning.
      pnpm(["install", "--frozen-lockfile", "--prod"]);
    }
  } finally {
    rmSync(managerRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { installGame(); }
  catch (error) { console.error(`install-game: ${error.message}`); process.exitCode = 1; }
}
