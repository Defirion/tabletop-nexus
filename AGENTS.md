# AGENTS.md

Tabletop Nexus is a small orchestration platform for independent browser-based tabletop games.

## Read first

1. `docs/PLAN.md` — current work and sequencing.
2. `GAME-CONTRACT.md` — compatibility boundary that game integrations must preserve.
3. `docs/ARCHITECTURE.md` — platform responsibilities and non-goals.
4. `VERIFICATION-CONTRACT.md` — required checks before review/merge.

## Non-negotiable boundaries

- Nexus may discover, launch, stop, health-check, and proxy games.
- Nexus must not understand or implement game rules, actions, rooms, or state.
- Games remain independent repositories/processes.
- Compatible games must support TV-less play.
- Do not add copyrighted game rules, artwork, assets, or transcribed game data to this repository.
- Do not expose local filesystem paths or launch commands through the browser API.
- Spawn declared commands directly; do not interpolate them through a shell.

## Change discipline

Keep changes scoped to the next unchecked roadmap item unless the user explicitly expands scope. Prefer small interfaces and tests over speculative framework work.

When the contract must change, update `GAME-CONTRACT.md` and its tests/documentation in the same PR. Avoid game-specific exceptions in Nexus; fix the contract or the game adapter instead.

## Review

A reviewer should verify behavior against the current roadmap item, contract, and verification contract. GitHub self-approval is not required; record a clear pass/block decision in the review conversation and merge only when blockers are resolved.
