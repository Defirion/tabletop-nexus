# Tabletop Nexus development guide

Keep work on this repository direct and product-focused. There are no mandatory agent roles, handoff documents, generated evidence reports, or repository-specific pull-request rituals.

## Working approach

- Read the task and only the product documentation relevant to it.
- Keep each change scoped and leave unrelated work intact.
- Use normal Git hygiene; prefer a branch for substantive work, but choose review and merge practices appropriate to the change.
- Add focused regression coverage for changed behavior and run `npm run verify` before considering the change complete.
- Record durable product decisions in the relevant product document, not in process instructions.

## Product authority

- `GAME-CONTRACT.md` is the normative compatibility boundary for games.
- `docs/ARCHITECTURE.md` defines current component and trust boundaries.
- `docs/DEPLOYMENT-MODEL.md` defines portable deployment constraints.
- `docs/REMOTE-PLAY.md` defines the stronger remote-play threat model and support gate.
- `docs/PLAN.md` records roadmap status and sequencing.

## Security invariants

Preserve these properties unless the change explicitly revises the architecture and its tests:

- Nexus owns the browser-facing ingress; game runtimes use Nexus-selected private listeners.
- Runtime commands remain server-side and launch as executable/argument arrays without shell interpolation.
- Nexus-owned launch values override inherited environment values, and readiness proves association with the current launch token.
- Lifecycle cleanup fails closed when runtime ownership is ambiguous; it must never signal an unrelated process merely because an OS identifier was reused.
- The private `__nexus` management namespace is never player-proxyable under any ASCII case alias or encoded form after canonicalization.
- Games own game rules, room/seat/reconnect identity, shared-state authorization, and game-specific secrecy. Nexus does not infer those semantics.
- Friends-only remote play remains unsupported until its documented gate passes. A supported remote deployment must separate public player ingress from private administration, run exposed game code under a security identity or sandbox distinct from Nexus, and deny that context access to host/provider credentials and sensitive control surfaces.

When a proposed shortcut weakens one of these boundaries, stop and treat it as an architecture decision rather than an incidental implementation detail.
