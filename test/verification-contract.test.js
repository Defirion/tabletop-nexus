import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("npm and the canonical verifier share the shell-free product check entrypoint", async () => {
  const [packageText, verifier] = await Promise.all([
    read("package.json"),
    read("verify.ps1"),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.scripts["verify:local"], "node scripts/verify-product.mjs");
  assert.match(
    verifier,
    /Invoke-External -Command 'node' -CommandArgs @\('scripts\/verify-product\.mjs'\)/,
  );
  assert.doesNotMatch(verifier, /Invoke-External -Command 'npm'/);
});

test("repository checks accept an initially empty shared check list and retain successful steps", async () => {
  const verifier = await read("verify.ps1");

  assert.match(
    verifier,
    /function Invoke-RepositoryChecks \{[\s\S]*?\[AllowEmptyCollection\(\)\]\[System\.Collections\.Generic\.List\[string\]\]\$Checks/,
  );
  assert.match(verifier, /\$checks = New-Object System\.Collections\.Generic\.List\[string\]/);
  assert.match(verifier, /Invoke-RepositoryChecks -Path \$verificationRoot -Checks \$checks/);
  assert.match(verifier, /\$Checks\.Add\('Required Agent-Workflow files are present\.'\)/);
  assert.doesNotMatch(verifier, /return \$checks/);
});

test("verification reports emit stable unstyled machine-readable SHA and outcome fields", async () => {
  const verifier = await read("verify.ps1");

  assert.match(verifier, /\$lines\.Add\("- Tested SHA: \$targetSha"\)/);
  assert.match(verifier, /\$lines\.Add\("- Automated outcome: \$outcome"\)/);
  assert.doesNotMatch(verifier, /\$lines\.Add\(\('- SHA: `\{0\}`' -f \$targetSha\)\)/);
  assert.doesNotMatch(verifier, /\$lines\.Add\("- Automated outcome: \*\*\$outcome\*\*"\)/);
  assert.doesNotMatch(verifier, /- SHA: `/);
  assert.doesNotMatch(verifier, /- Automated outcome: \*\*/);
});
