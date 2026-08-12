# Verification contract

Local verification is the authoritative development gate for Tabletop Nexus.

## Required before review

From a fresh checkout:

```bash
npm install
npm run verify:local
```

`verify:local` must run the complete automated baseline relevant to the repository: type checking and tests.

A lockfile should be added once dependency resolution is performed in the development environment; until then the scaffold pins its direct development dependencies exactly.

## Manual verification

Manual LAN/browser verification is required only when a change affects behavior that automated tests do not cover, such as real-device routing, WebSocket upgrades, or platform-specific child-process shutdown.

Record any required manual verification and result in the PR description or review handoff.

## Review and merge

- Reviewers inspect the requested roadmap scope and automated results.
- Formal GitHub self-approval is not required or expected.
- A reviewer records a clear pass or blocker outcome.
- Blockers must be resolved before merge.
- Keep GitHub-hosted CI lightweight if/when it is added; the full local suite remains the primary gate during active development.

## Current baseline

```bash
npm run typecheck
npm test
```

The scaffold does not yet claim end-to-end process/proxy coverage. Those gates are added with R1/R2 rather than represented by placeholder checks.
