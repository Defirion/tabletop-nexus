import { spawnSync } from "node:child_process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function fail(message) {
  throw new Error(message);
}

function parseMode(args) {
  if (args.length === 1 && args[0] === "--local") {
    return { mode: "local" };
  }
  if (args.length === 2 && args[0] === "--canonical-target" && SHA_PATTERN.test(args[1])) {
    return { mode: "canonical", targetSha: args[1].toLowerCase() };
  }
  fail("verify-product.mjs requires explicit --local or --canonical-target <40-character SHA> mode");
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`git rev-parse HEAD failed with exit code ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().toLowerCase();
}

const verification = parseMode(process.argv.slice(2));
if (verification.mode === "canonical") {
  const head = gitHead();
  if (head !== verification.targetSha) {
    fail(`canonical product verifier checkout is ${head}, expected ${verification.targetSha}`);
  }
}

const checks = [
  ["--check", "src/registry.js"],
  ["--check", "src/runtime/private-ports.js"],
  ["--check", "src/server.js"],
  ["--check", "public/app.js"],
  ["--test"],
];

for (const args of checks) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
