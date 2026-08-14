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

The verifier must:

1. Resolve the target from GitHub:
   - no open PRs -> fetch, fast-forward, and verify `main`;
   - one open PR -> verify it automatically;
   - several open PRs -> prompt for a choice, or use `-Pr` non-interactively.
2. Bind verification to the exact GitHub target SHA before checks begin. Local branch state is never authoritative.
3. Refuse modified tracked files or staged changes. Untracked/gitignored files may remain unless they could affect the result. Normal target checkout must refuse rather than overwrite ignored files that collide with the selected target; use `-Isolated` when preserving the active checkout matters.
4. Support isolated verification with `-Isolated`.
5. Run the repository's canonical automated checks and confirm they leave no unexpected tracked/staged changes.
6. Recheck the GitHub target afterward. If it moved, the evidence is `STALE`.
7. Write a timestamped ignored Markdown report under `.local/pr-verification/` and replace `.local/pr-verification/latest.md` with the newest report.

## Current automated gate

The automated gate validates both workflow integrity and the R0 product baseline:

- required Agent-Workflow files are present;
- `docs/ai/BASELINE` contains the expected source plus a full 40-character commit SHA;
- Node.js 22 or newer is available;
- required R0 product files are present;
- `node scripts/verify-product.mjs` passes, which syntax-checks the server/registry/portal JavaScript and runs the Node test suite;
- the verification checkout remains free of tracked/staged changes.

`npm run verify:local` is a developer convenience wrapper around the same shell-free Node product verifier. The canonical PowerShell verifier invokes Node directly so its product gate does not depend on platform-specific npm command shims. R0 intentionally has no package dependencies, so verifier setup does not require `npm install`.

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

## Report minimum

Record:

- target (`main` or PR number), full tested SHA, mode, PowerShell version, and timestamp;
- automated outcome and checks completed before any failure;
- final tracked/staged worktree state;
- target-freshness result;
- `## Human verification required` state/contents;
- relevant failure output or environment limitations.

A timestamped report preserves local history; `latest.md` is the stable handoff path for humans and tooling such as Repo-Relay.
