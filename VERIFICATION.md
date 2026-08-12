# Verification

Tabletop Nexus follows the repository-agnostic verification contract from `Defirion/Agent-Workflow`, adapted to this repository.

## Canonical verifier

Run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1
```

Select a PR explicitly when needed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 -Pr 12
```

Use `-Isolated` when preserving the active checkout matters.

The verifier must:

1. Resolve the target from GitHub:
   - no open PRs -> fetch, fast-forward, and verify `main`;
   - one open PR -> verify it automatically;
   - several open PRs -> prompt for a choice, or use `-Pr` non-interactively.
2. Bind verification to the exact GitHub target SHA before checks begin. Local branch state is never authoritative.
3. Refuse modified tracked files or staged changes. Untracked/gitignored files may remain unless they could affect the result.
4. Support isolated verification with `-Isolated`.
5. Run the repository's canonical automated checks and confirm they leave no unexpected tracked/staged changes.
6. Recheck the GitHub target afterward. If it moved, the evidence is `STALE`.
7. Write a timestamped ignored Markdown report under `.local/pr-verification/` and replace `.local/pr-verification/latest.md` with the newest report.

## Current bootstrap gate

Before application tooling exists, the automated gate validates the workflow scaffold itself:

- required Agent-Workflow files are present;
- `docs/ai/BASELINE` contains the expected source plus a full 40-character commit SHA;
- the verification checkout remains free of tracked/staged changes.

When product tooling is introduced, extend the automated checks in `verify.ps1` with the canonical tests/build/typecheck/smoke checks. **Do not change the verifier interface or evidence contract merely because the implementation stack changes.**

## Role boundary

Verification is for executable or environment-dependent evidence: tests, builds, runtime probes, integration behavior, UI interaction, hardware, credentials, external services, or similar observations.

Static checks answerable by inspecting the diff, code, documentation, configuration, or repository state belong to the Reviewer. Do not turn them into Verifier blockers.

A Verifier may attest only to evidence it actually established. Evidence supplied by a human or another environment must be identified as supplied rather than silently treated as self-verified.

## Human verification handoff

Every implementation PR must contain this exact heading:

```markdown
## Human verification required
```

Write `None` unless evidence requires a real human/external environment that automated checks and repository inspection cannot establish. Otherwise list each check, what the human should do, and the expected observation.

For a PR target, the canonical verifier surfaces this section in the report. A missing section is an incomplete handoff and must not be treated as `None`.

Automated success does not satisfy human-required checks. Keep automated evidence and human evidence separate.

## Report messaging

The generated report describes the automated gate unambiguously:

- `PASS` — canonical automated checks completed successfully for the exact fresh SHA;
- `FAIL` — an automated check failed;
- `STALE` — the GitHub target moved and the result cannot be used.

When automated verification passes and human verification is `None`, the report says the automated gate is complete and the PR is ready for independent Review. Human-required checks, when declared, remain a separate gate.

## Report minimum

Record:

- target (`main` or PR number), full tested SHA, mode, and timestamp;
- automated outcome and checks;
- final tracked/staged worktree state;
- target-freshness result;
- `## Human verification required` state/contents;
- relevant failure output or environment limitations.

A timestamped report preserves local history; `latest.md` is the stable handoff path for humans and tooling such as Repo-Relay.
