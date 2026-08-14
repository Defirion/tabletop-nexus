# Plan

GitHub PR state is the operational source of truth. Checkboxes describe implementation present on the branch containing this document; merge-readiness is decided only by the independent Verifier/Reviewer workflow in `AGENTS.md`.

## R0 — Platform baseline

- [x] Establish public project scope and architecture boundary.
- [x] Define schema-1 `boardgame.json` integration contract.
- [x] Make TV-less play mandatory for compatible games.
- [x] Add a runnable portal/API scaffold.
- [x] Add local configuration discovery and manifest validation.
- [ ] Merge scaffold after independent verification and review.

## R1 — Runtime supervisor

- [ ] Allocate private game ports.
- [ ] Spawn manifest-declared game processes without shell interpolation.
- [ ] Supply `HOST`, `PORT`, and `BASE_PATH`.
- [ ] Poll game health and expose lifecycle state.
- [ ] Implement graceful stop plus forced-shutdown fallback.
- [ ] Add lifecycle tests using a tiny original fixture game.

## R2 — Single-port routing

- [ ] Reverse-proxy HTTP under `/games/<id>/`.
- [ ] Support WebSocket upgrades.
- [ ] Verify SSE/streaming behavior.
- [ ] Reject invalid/unregistered game routes.
- [ ] Add end-to-end routing tests against the fixture game.

## R3 — First real adapters

- [ ] Adapt Pirate Island to the game contract.
- [ ] Adapt Flipping Stories/Captain Flip to a one-process LAN runtime.
- [ ] Add base-path support to both games.
- [ ] Add/verify TV-less mode in both games.
- [ ] Keep those game repositories independent; no copyrighted content enters Nexus.

## R4 — Library UX and resilience

- [ ] Start/stop controls and visible lifecycle state.
- [ ] Friendly startup failures and logs.
- [ ] Game metadata/artwork hooks using only distributable assets.
- [ ] Recover cleanly after Nexus restarts.
- [ ] Mobile-friendly portal.

## R5 — Public-project polish

- [ ] Add an entirely original fixture/demo game.
- [ ] Decide and add project license.
- [ ] Add contribution guidance.
- [ ] Document installation on Windows/Linux/macOS.
- [ ] Define compatibility/versioning policy for future contract revisions.
