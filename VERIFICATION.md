# Verification

Tabletop Nexus follows the repository-agnostic verification contract from `Defirion/Agent-Workflow`, adapted to this repository.

## Canonical verifier

The canonical verifier requires PowerShell 7 or newer. Run it from the repository root with `pwsh`:

```powershell
pwsh -NoProfile -File .\verify.ps1
```

Select a PR explicitly when needed:

```powershell
pwsh -NoProfile -File .\verify.ps1 -Pr 12
```

Use `-Isolated` when preserving the active checkout matters.

The verifier entrypoint is deliberately two-stage. The caller checkout is only a bootstrap for resolving and materializing the GitHub target. Before repository checks begin, the bootstrap starts a fresh PowerShell process using `verify.ps1` from the selected target checkout/worktree. The target-bound process confirms that its canonical script path and checked-out `HEAD` match the exact selected target SHA, then rechecks that SHA against GitHub before and after the automated gate. This prevents repository-check logic already loaded from another local checkout from becoming authoritative.

The product verifier also requires an explicit execution mode. Canonical verification invokes `node scripts/verify-product.mjs --canonical-target <SHA>`, which confirms the current checkout `HEAD` matches that SHA before running product checks. `npm run verify:local` uses the separate `--local` mode. A no-argument product-verifier invocation is rejected so verifier versions from before target-bound re-execution cannot silently certify a newer target with stale PowerShell rules.

The verifier must:

1. Resolve the target from GitHub:
   - no open PRs -> fetch, fast-forward, and verify `main`;
   - one open PR -> verify it automatically;
   - several open PRs -> prompt for a choice, or use `-Pr` non-interactively.
2. Bind verification to the exact GitHub target SHA before checks begin. Local branch state is never authoritative: repository checks execute from that target's own `verify.ps1`, and the target checkout `HEAD` must equal the selected SHA.
3. Refuse modified tracked files or staged changes. Untracked/gitignored files may remain unless they could affect the result. Normal target checkout must refuse rather than overwrite ignored files that collide with the selected target; use `-Isolated` when preserving the active checkout matters.
4. Support isolated verification with `-Isolated`; isolated mode must execute the verifier from the target worktree, not from the caller checkout.
5. Run the repository's canonical automated checks and confirm they leave no unexpected tracked/staged changes.
6. Recheck the GitHub target afterward. If it moved, the evidence is `STALE`.
7. Write a timestamped ignored Markdown report under `.local/pr-verification/` and replace `.local/pr-verification/latest.md` with the newest report.

## Current automated gate

The automated gate validates both workflow integrity and the current product baseline:

- target-bound verifier logic is loaded from the exact tested SHA;
- required Agent-Workflow files are present;
- `docs/ai/BASELINE` contains the expected source plus a full 40-character commit SHA;
- Node.js 22 or newer is available;
- required product files are present;
- `node scripts/verify-product.mjs --canonical-target <SHA>` passes, which confirms checkout identity, syntax-checks the server, registry, private-port allocator, process launcher, and portal JavaScript, and runs the Node test suite;
- the verification checkout remains free of tracked/staged changes.

`npm run verify:local` is a developer convenience wrapper that invokes the same shell-free Node product verifier in explicit local mode. The canonical PowerShell verifier invokes Node directly so its product gate does not depend on platform-specific npm command shims. The current product has no package dependencies, so verifier setup does not require `npm install`.

When a later automated check fails, the report retains the earlier checks that completed successfully before that failure. When later milestones introduce dependencies or build tooling, extend the product verifier with the repository's canonical install/build/typecheck/test/smoke commands while preserving this verifier interface and evidence contract.

## Role boundary

Verification is for executable or environment-dependent evidence: tests, builds, runtime probes, integration behavior, UI interaction, hardware, credentials, external services, or similar observations.

Static checks answerable by inspecting the diff, code, documentation, configuration, or repository state belong to the Reviewer. Do not turn them into Verifier blockers.

A Verifier may attest only to evidence it actually established. Evidence supplied by a human or another environment must be identified as supplied rather than silently treated as self-verified.

## Human verification handoff

Every implementation PR must contain exactly one of this heading:

```markdown
## Human verification required
```

The section must contain either exactly `None`, or a non-empty concrete declaration of the human/external checks required. A missing heading, duplicate heading, empty section, or `None` mixed with other content is an invalid handoff and must not be treated as `None`.

When human verification is required, list each check, what the human should do, and the expected observation.

For a PR target, the canonical verifier surfaces this section in the report. An invalid handoff prevents a successful reviewer handoff even when the automated gate passes.

Automated success does not satisfy human-required checks. Keep automated evidence and human evidence separate.

## Report messaging

The generated report describes the automated gate unambiguously:

- `PASS` — canonical automated checks completed successfully for the exact fresh SHA;
- `FAIL` — an automated check failed;
- `STALE` — the GitHub target moved and the result cannot be used.

When automated verification passes and human verification is `None`, the report says the automated gate is complete and the PR is ready for independent Review. Human-required checks, when declared, remain a separate gate.

## Stable machine-readable fields

Every generated verification report contains these compatibility fields exactly, with no Markdown styling around either value:

```text
- Tested SHA: <full 40-character SHA>
- Automated outcome: PASS|FAIL|STALE
```

These labels and value formats are stable for Repo-Relay and other tooling. They do not weaken the verification contract: consumers must still require the tested SHA to equal the exact current GitHub target, require fresh evidence, and reject `FAIL`, `STALE`, wrong-SHA, duplicate, or contradictory evidence.

## Report minimum

Record:

- target (`main` or PR number), full tested SHA, verifier source SHA, mode, PowerShell version, and timestamp;
- automated outcome and checks completed before any failure;
- final tracked/staged worktree state;
- target-freshness result;
- `## Human verification required` state/contents;
- relevant failure output or environment limitations.

A timestamped report preserves local history; `latest.md` is the stable handoff path for humans and tooling such as Repo-Relay.
