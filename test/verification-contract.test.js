import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function runProductVerifier(args) {
  return spawnSync(process.execPath, ["scripts/verify-product.mjs", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    shell: false,
  });
}

test("npm and canonical verification use explicit product-verifier modes", async () => {
  const [packageText, verifier] = await Promise.all([
    read("package.json"),
    read("verify.ps1"),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.scripts["verify:local"], "node scripts/verify-product.mjs --local");
  assert.match(
    verifier,
    /Invoke-External -Command 'node' -CommandArgs @\('scripts\/verify-product\.mjs', '--canonical-target', \$TargetSha\)/,
  );
  assert.doesNotMatch(verifier, /Invoke-External -Command 'npm'/);
});

test("target bootstrap re-executes the selected checkout verifier before repository checks", async () => {
  const verifier = await read("verify.ps1");

  assert.match(verifier, /\$targetVerifier = Join-Path \$verificationRoot 'verify\.ps1'/);
  assert.match(
    verifier,
    /& \$pwsh -NoProfile -File \$targetVerifier -Pr \$boundPr -BoundTargetSha \$target\.Sha -BoundTargetKind \$target\.Kind -ReportRoot \$repoRoot -BoundMode \$mode/,
  );
  assert.match(verifier, /if \(\$BoundTargetSha\) \{\s*exit \(Invoke-BoundVerification\)\s*\}/);
  assert.match(
    verifier,
    /function Invoke-BoundVerification \{[\s\S]*?Assert-CanonicalVerifierPath -RepoRoot \$repoRoot[\s\S]*?\$checkedOutSha = Invoke-Git -CommandArgs @\('rev-parse', 'HEAD'\)[\s\S]*?Invoke-RepositoryChecks -Path \$repoRoot -TargetSha \$BoundTargetSha -Checks \$checks/,
  );
  assert.match(verifier, /\$checks\.Add\("Verifier logic loaded from tested target SHA \(\$BoundTargetSha\)\."\)/);
});

test("legacy pre-bootstrap canonical invocation cannot certify a newer target", () => {
  const result = runProductVerifier([]);

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /requires explicit --local or --canonical-target <40-character SHA> mode/,
  );
});

test("canonical product verifier rejects a target SHA that does not match checkout HEAD", () => {
  const wrongSha = "0".repeat(40);
  const result = runProductVerifier(["--canonical-target", wrongSha]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /canonical product verifier checkout is .* expected 0000000000000000000000000000000000000000/);
});

test("canonical verifier requires R1 private-port source and focused regression coverage", async () => {
  const verifier = await read("verify.ps1");
  const requiredMatch = verifier.match(/\$productRequired = @\(([\s\S]*?)\n\s*\)/);

  assert.ok(requiredMatch, "productRequired block must remain explicit");
  assert.match(requiredMatch[1], /'src\/runtime\/private-ports\.js'/);
  assert.match(requiredMatch[1], /'test\/private-ports\.test\.js'/);
  assert.match(verifier, /Required product file is missing:/);
  assert.match(verifier, /\$Checks\.Add\('Required product files are present\.'\)/);
  assert.match(verifier, /Node\.js runtime satisfies the product requirement/);
  assert.match(verifier, /Product syntax checks and tests passed/);
  assert.doesNotMatch(verifier, /Required R0 product|R0 requirement|R0 product syntax checks/);
});

test("repository checks accept an initially empty shared check list and retain successful steps", async () => {
  const verifier = await read("verify.ps1");

  assert.match(
    verifier,
    /function Invoke-RepositoryChecks \{[\s\S]*?\[AllowEmptyCollection\(\)\]\[System\.Collections\.Generic\.List\[string\]\]\$Checks/,
  );
  assert.match(verifier, /\$checks = New-Object System\.Collections\.Generic\.List\[string\]/);
  assert.match(verifier, /Invoke-RepositoryChecks -Path \$repoRoot -TargetSha \$BoundTargetSha -Checks \$checks/);
  assert.match(verifier, /\$Checks\.Add\('Required Agent-Workflow files are present\.'\)/);
  assert.doesNotMatch(verifier, /return \$checks/);
});

test("verification reports emit stable fields plus verifier-source binding", async () => {
  const verifier = await read("verify.ps1");

  assert.match(verifier, /\$lines\.Add\("- Tested SHA: \$TargetSha"\)/);
  assert.match(verifier, /\$lines\.Add\("- Verifier source SHA: \$TargetSha"\)/);
  assert.match(verifier, /\$lines\.Add\("- Automated outcome: \$Outcome"\)/);
  assert.doesNotMatch(verifier, /\$lines\.Add\(\('- SHA: `\{0\}`' -f \$targetSha\)\)/);
  assert.doesNotMatch(verifier, /- Automated outcome: \*\*/);
});
