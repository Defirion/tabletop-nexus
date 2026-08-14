import { spawnSync } from "node:child_process";

const checks = [
  ["--check", "src/registry.js"],
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
