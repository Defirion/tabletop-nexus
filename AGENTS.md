# Tabletop Nexus Agent Workflow

GitHub is the source of truth for code, tasks, pull requests, verification evidence, review, and merge state.

## Workflow

```text
Task -> Implement -> PR -> Verify -> Review -> Merge
                         ^         |
                         +-- Fix <-+
```

Work happens on branches and is handed between roles through the pull request. Verification and review apply only to the exact commit SHA inspected; any new commit makes that evidence stale.

## Roles

Read only the instructions for the assigned role:

- **Implementer:** `docs/ai/IMPLEMENTER.md`
- **Verifier:** `docs/ai/VERIFIER.md`
- **Reviewer:** `docs/ai/REVIEWER.md`

Do not combine role responsibilities in one run. The Implementer does not make the independent merge-readiness decision; Verifiers and Reviewers do not modify implementation code.

## Shared rules

- Do not work directly on `main`.
- Keep changes scoped to the task and its acceptance criteria.
- Repository documentation and committed project rules override chat assumptions.
- The PR is the canonical operational handoff between roles.
- `VERIFICATION.md` defines the canonical local-verification and evidence contract.
- `.local/pr-verification/latest.md` is the stable local evidence handoff path.
- Repository-local verification is authoritative when GitHub-hosted CI is absent, optional, or manual.
- `docs/ai/BASELINE` records the Agent-Workflow commit this repository was last reconciled against.
- Product-specific architecture, contracts, plans, and commands belong in Tabletop Nexus documentation, not in these role files.
