# Plan

Checkboxes describe implementation present on the branch containing this document. Update them when the corresponding product behavior and regression coverage land.

## R0 — Platform baseline

- [x] Establish public project scope and architecture boundary.
- [x] Define schema-1 `boardgame.json` integration contract.
- [x] Make TV-less play mandatory for compatible games.
- [x] Add a runnable portal/API scaffold.
- [x] Add local configuration discovery and manifest validation.
- [x] Verify the scaffold with automated product checks.

## R1 — Runtime supervisor

- [x] Allocate private game ports.
- [x] Spawn manifest-declared game processes without shell interpolation.
- [x] Keep the launch boundary compatible with the remote-play isolation requirement: supported internet-facing deployment must be able to run games under a security identity/sandbox distinct from Nexus rather than relying on a same-OS-identity child as the only separation from trusted player ingress or administration.
- [x] Supply `HOST`, `PORT`, and `BASE_PATH` as environment variables and require the child to bind the assigned private host/port.
- [x] Migrate the game contract to schema 2 and replace configurable `runtime.healthPath` with the fixed private `GET /__nexus/status` readiness surface, updating `GAME-CONTRACT.md`, manifest validation, and tests atomically rather than redefining schema 1 in place.
- [x] Poll the fixed Nexus readiness surface and expose lifecycle state.
- [x] Implement graceful `SIGTERM` stop on Linux plus forced-shutdown fallback.
- [x] Enforce the initial one-active-game policy: stop the current runtime and release its process/port resources before starting another game runtime.
- [x] Add lifecycle tests using a tiny original fixture game.

## R2 — Single-port routing

- [ ] Reverse-proxy HTTP under `/games/<id>/`, stripping the game `BASE_PATH` before forwarding to the private runtime except that any canonical post-prefix first path segment equal to ASCII `__nexus` case-insensitively is reserved and never player-proxyable.
- [ ] Support WebSocket upgrades on the same game runtime/port.
- [ ] Verify SSE/streaming behavior.
- [ ] Reject invalid/unregistered game routes and any public path whose canonical post-prefix first segment is an ASCII case-insensitive match for `__nexus`, including encoded forms that canonicalize to such a case alias.
- [ ] Add end-to-end routing tests against the fixture game, including lowercase `/games/<id>/__nexus/status`, direct mixed-case aliases such as `/games/<id>/__NEXUS/status` and `/games/<id>/__Nexus/status`, encoded mixed-case/canonicalization variants, unchanged ordinary game routes, near-name controls such as `/games/<id>/__nexusx/status` and `/games/<id>/__nexus-status`, and direct private Nexus readiness polling as a positive control.

## Contract revision gate before R3

Before adapting the real games, promote the remaining deliberately selected stricter common game shape into the normative contract and implementation together.

- [ ] Decide whether the remaining promoted behavioral requirements require a further contract/schema revision; do not silently redefine an already-supported contract version.
- [ ] Promote the remaining selected runtime/browser/session requirements recorded in `docs/GAME-AUTHORING-GUIDE.md`, including same-origin browser behavior, service-worker containment, clean shutdown compatibility checks, server-authoritative shared state, session/recovery expectations where applicable, mandatory TV-less/standalone play, and the canonical optional `BASE_PATH/board/` entrypoint when dedicated-display support is advertised.
- [ ] Define the future dedicated-display capability semantics so advertising dedicated-display support means the canonical public board entrypoint exists, while games that do not advertise it have no board-route requirement and every compatible game remains fully playable without that display.
- [ ] Define the minimal optional Nexus player-presentation handoff: a reusable display name remains distinct from any opaque Nexus browser/profile ID, and neither replaces game-owned room/seat/reconnect identity or authorization.
- [ ] Add reusable compatibility checks for the promoted integration requirements without teaching Nexus game rules or game-specific payloads.

## R3 — First real adapters

- [ ] Adapt Pirate Island to the game contract.
- [ ] Adapt Flipping Stories/Captain Flip to a one-process LAN runtime.
- [ ] Add base-path support to both games.
- [ ] Add/verify TV-less standalone mode in both games.
- [ ] Expose Captain Flip's existing TV/shared-board experience through the canonical optional `BASE_PATH/board/` entrypoint while keeping complete play possible without it.
- [ ] Keep those game repositories independent; no copyrighted content enters Nexus.

## R4 — Library UX and resilience

- [ ] Start/stop controls and visible lifecycle state.
- [ ] Friendly startup failures and logs.
- [ ] Add the reusable Nexus player-presentation profile UX once its pre-R3 handoff is defined.
- [ ] When the active game advertises dedicated-display support, offer an **Open board display** action/QR that opens its canonical `BASE_PATH/board/` entrypoint on an extra tablet, TV, monitor, or browser.
- [ ] Game metadata/artwork hooks using only distributable assets.
- [ ] Recover cleanly after Nexus restarts.
- [ ] Mobile-friendly portal.

## R5 — Public-project polish

- [ ] Add an entirely original fixture/demo game.
- [ ] Decide and add project license.
- [ ] Add contribution guidance.
- [ ] Document installation on Windows/Linux/macOS.
- [ ] Define compatibility/versioning policy for future contract revisions.

## R6 — Friends-only remote play support

`docs/REMOTE-PLAY.md` is the detailed architecture and acceptance gate for this milestone. The roadmap items below group that work; they do not weaken or replace its support-gate requirements.

- [ ] Separate private administration from public player ingress, with supported Linux player ingress using a protected Unix socket or a documented compensated exception.
- [ ] Run supported remote game runtimes under a distinct security identity/sandbox from Nexus and deny the real game execution context access to trusted player ingress, the Nexus admin control plane, and provider/host credential or sensitive-control surfaces.
- [ ] Establish VM and per-game resource limits, crash-loop controls, and the deployment-profile checks needed to prove the supported game sandbox retains required game networking while remaining isolated from local control authority.
- [ ] Complete remote-player proxy hardening for canonical path/traversal handling, Host validation, forwarded-header/client attribution, HTTP framing and size/time/connection limits, WebSocket Origin/message/backpressure behavior, SSE cleanup, and generic failure responses.
- [ ] Add explicit Tailscale admin grants plus admin Host, CSRF, frame, and audit protections.
- [ ] Resolve the Cloudflare Tunnel credential model and document credential storage, ownership, rotation/revocation, and the external disable procedure before production public ingress.
- [ ] Configure player-only Cloudflare ingress and verify that game ports and admin surfaces are not directly exposed to the public internet or unintended LAN paths over IPv4 or IPv6.
- [ ] Add local and external public-ingress kill switches and restrict unnecessary game access to sensitive LAN/tailnet peers while preserving explicitly allowed ordinary public-internet egress.
- [ ] Add expected-player configuration, approximate presence, route/IP/connection anomaly signals, structured warnings/events, and safe throttling without making presence cookies authoritative identity.
- [ ] Add the stable HTTPS friend invite flow, including copy-link and QR actions, no-login joining, and configurable idle shutdown.
- [ ] Verify representative secure-context/mobile-browser behavior, WSS/SSE and reconnect flows, Nexus-owned security headers, and service-worker containment.
- [ ] Produce the security/operations companion documentation required for the supported deployment profile, including patch/update handling and any threat-model, hardening, monitoring, or incident-response artifacts needed by the final support gate.
- [ ] Declare friends-only remote play supported only after every applicable `docs/REMOTE-PLAY.md` support-gate check passes for at least one documented deployment profile.
