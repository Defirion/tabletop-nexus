# Tabletop Nexus — contract baseline, real adapters, and a usable LAN library

Status: **active roadmap**. Adopted 5 October 2026. Milestones below describe intended work; adoption does not mark implementation or acceptance complete.

## Roadmap authority and preserved detail

This is the active project plan. The [previous plan](archive/PLAN-before-adoption-2026-10-05.md) is preserved verbatim, including the local edits present at adoption. Its detailed product requirements and regression cases remain references; its old sequencing/status text is superseded here. Current game-law, runtime-contract, and verification documents retain their established authority. No retired agent-role or exact-SHA attestation workflow is reinstated.

The baseline observations below are dated snapshots. Recheck source and working changes before implementation; historical commits, PR descriptions, and prior test counts are not fresh acceptance evidence.

Updated 6 October 2026. Repository: `C:/Users/defir/Documents/fun_with_Copilot/tabletop-nexus`, `Defirion/tabletop-nexus`.

## Outcome

A host opens one usable portal, starts Captain Flip or Pirate Island, and gives players a single Nexus-origin link. The selected game handles its own sessions and rules. Switching/stop/restart behavior is clear and releases the old runtime safely. Both games remain fully playable without a TV; Captain Flip's optional shared board is discoverable from the portal.

Finish the LAN product before beginning the separate friends-only remote-play support milestone.

## Baseline at adoption (5 October 2026)

- Local `main` HEAD is `3e49051e6d8129451e524433b47c6797a773adc9`, with substantial uncommitted changes to contract/docs/registry/tests and a new `src/game-compatibility.js` helper.
- Published GitHub `GAME-CONTRACT.md` is manifest schema 2. The working contract/validator promote manifest schema 3; the working roadmap marks this revision gate implemented. Verify/finalize this existing work rather than redesigning it.
- Runtime supervision and single-port HTTP/WebSocket/SSE routing are implemented. Preserve private bind, launcher-owned identity, management-route reservation, and owned-process shutdown boundaries.
- Schema-3 game manifests are distinct from schema-2 readiness payloads. Published schema-2 games are rejected by the current working validator, making this an explicit migration.
- The current portal renders game cards and lifecycle status but has no player-facing start/stop/open controls in the inspected `public/app.js`.
- The compatibility helper checks successful landing and optional board routes plus redirect containment. It does not validate game actions, rooms, assets, transport recovery, or TV-less play.
- Pirate Island has a schema-2 adapter. Captain Flip needs a one-listener production runtime and complete phone hosting.

## N0 — Finalize the existing schema-3 contract and implementation

**Dependencies:** none. **First shared execution slice.**

**Status: completed locally, 6 October 2026.** The commit containing this entry on `codex/n0-schema-3-baseline` establishes the reproducible schema-3 adapter baseline. It preserves the adoption changes and archived plan; publication/integration into upstream `main` has not been performed by this milestone.

Fresh verification: focused registry/compatibility/server/launcher checks passed, followed by `npm run verify` (100 tests: 94 passed, 6 Linux-only checks skipped on Windows; no failures). The full gate includes real fixture HTTP/board routes, WebSocket/SSE behavior, reserved management aliases, current-launch readiness, and runtime switching. Linux process-group acceptance remains N1/N3 work; this result does not establish a supported Linux deployment or real-game compatibility.

The contract, validator, fixture, and docs agree on manifest schema 3 and private readiness payload schema 2. Registry/API regression coverage verifies mandatory TV-less support, typed capabilities, executable/argument arrays, rejection of old manifests, and exclusion of paths/commands/tokens/unknown metadata from public output. The route checker uses the proxy's path parser, rejects cross-origin/out-of-base/reserved/ambiguous/credential redirects, bounds navigation redirects and request time, and releases response bodies. It checks route availability only; game-owned behavior and browser assets remain adapter acceptance work.

Migration impact is explicit: schema-2 registrations (including the current Pirate Island adapter) fail the library load until removed or migrated. No manifest or capability is automatically upgraded. Portal controls and the optional presentation-profile transport remain N2 work.

1. Inspect and preserve current uncommitted changes; identify which changes belong to the contract revision. Verify the baseline before integrating other repositories.
2. Keep `GAME-CONTRACT.md` normative, with architecture/authoring/roadmap docs aligned. Explicitly state manifest schema 3, unchanged readiness schema 2, schema-2 manifest rejection, and the migration impact on currently configured games.
3. Verify required `tvLess`, capability validation, dedicated-display semantics, browser-safe public metadata, and direct executable/argument-array launch. Do not expose repository paths, runtime arguments, or launch tokens in `/api/games`.
4. Verify same-origin/base-path behavior, optional service-worker containment, session create/joinable discovery/recovery, and clean shutdown are documented as game obligations. The optional display-name suggestion is not shared identity or authorization.
5. Validate the compatibility helper's public landing/optional-board routing and redirect containment, including negative cases. Preserve its narrow boundary; do not make it infer game rules or credentials.
6. Run focused registry/compatibility tests and `npm run verify`. Reconcile checked roadmap items with actual implemented behavior, then integrate the revision through ordinary Git workflow when executing the plan.

**Exit:** one tested/reproducible schema-3 baseline that the game adapters can name. Record whether it is local, committed, or published accurately. No automatic manifest upgrade that silently advertises behavior a game has not implemented.

## N1 — Prove both real adapters through the platform

**Dependencies:** N0; Pirate PI1 and Captain CF1–CF2. Coordinate game-owned integration checks PI2 and CF3 during this milestone.

- Register games using local configuration, keeping paths and personal game assets out of public Nexus metadata/source.
- Use Pirate Island first because its runtime seam already exists. Complete its schema migration, room discovery, and same-origin physics delivery in its repository.
- Integrate Captain Flip after its single runtime, path-safe links, game-owned creation/hosting, and optional board route exist in its repository.
- Execute the shared public-route checker after Nexus launch for each game. Verify `dedicatedDisplay: true` requires the canonical board route; Pirate can remain false without a board-route requirement.
- Add observable integration coverage for HTTP assets/navigation, Captain's WS, Pirate's SSE, readiness identity, graceful stop, unexpected exit, and repeated game switching. Use generic original fixtures for ordinary automated platform regression coverage; use the real games for adapter acceptance without copying their rules/art into Nexus.
- Keep game-specific create/join/reconnect/authority assertions in game tests. The combined campaign launches via Nexus and exercises them using game-owned test clients; Nexus production code must not branch on game IDs to understand their protocols.
- Verify a wrong/missing launch token cannot make a process on the assigned port ready. Test public encoded/case aliases of the private `__nexus` segment and preserve the existing near-name controls.
- On Linux, verify graceful and forced shutdown, root/helper exit, unexpected controller disappearance, and process/port ownership. Never release the old lease and launch a replacement while old owned listeners/helpers remain unresolved.

**Acceptance matrix:** start Pirate → create/join/play/reconnect → stop → start Captain → create/join/phone-host/optional-board/reconnect → switch back. Old streams/sockets close, listener leases do not leak, and public requests stay beneath the selected game path.

**Exit:** both schema-3 adapter checklists pass. R3 roadmap items can be marked implemented only where the actual corresponding behavior and regression coverage exist. Real-device game observations remain in PI3/CF4 if not yet completed.

## N2 — Finish library UX and restart resilience

**Dependencies:** N1 for accepted game behavior; interface work may be prepared earlier against the fixture.

### Usable host and player surfaces

- Add host-facing start/stop/switch controls, visible Starting/Running/Stopping/Stopped/Failed state, and clear bounded startup failures. Use current lifecycle APIs rather than duplicating the supervisor in browser code.
- Provide an **Open game** action only for a ready runtime and build its URL from the registered game base path. Show an **Open board display** link/QR only when the manifest advertises dedicated display. All links use the public Nexus origin.
- Keep platform stop/switch separate from a game's host/seat controls. Display that switching ends the active game's current session unless that game later adds persistence.
- Keep interface text useful to a host/player; show technical log details in an optional host diagnostic surface, not as the normal user flow. A failure never exposes tokens, filesystem secrets, or raw unsafe command strings publicly.
- Make cards, actions, status, and error recovery usable on a phone, with keyboard/focus support and clear state changes.

### Restart behavior

- Recover the configured library after Nexus restart and show truthful lifecycle state. Explicitly document whether a clean restart ends live games; do not imply saved rooms or seamless game resume.
- Reconcile stale runtime/port state only when ownership is established by the existing generation-aware boundary. If ownership is ambiguous, stop replacement and show an actionable host diagnosis; do not signal an unrelated process or erase its lease to appear healthy.
- Test clean restart, crash/restart, interrupted launch, and failed cleanup. Keep one-active-game behavior consistent across these cases.

### Optional presentation profile

After the core controls work, a small browser-local display-name profile can satisfy the planned R4 handoff: editable suggestion, absent-by-default compatibility, and no authoritative meaning. First define/test one versioned transport for the suggestion in the contract. Never forward Nexus's opaque browser/profile ID as a room, seat, host, or reconnect credential.

This profile is not a blocker for the first useful LAN release; each game's own create/join name entry remains sufficient.

**Exit:** a host can operate both games through the portal without commands; failures/switching are understandable; restart behavior is deterministic and accurately documented. Game-owned authority remains entirely separate.

## N3 — Integrated LAN release

**Dependencies:** N1/N2 and final Pirate PI3/PI4 + Captain CF4 acceptance.

1. Run `npm run verify`, then the combined real-game acceptance campaign on the final platform/adapters. Routine platform tests use the original fixture; real-device checks are recorded separately.
2. Verify the supported Linux deployment/lifecycle environment and representative host/phone LAN paths. Windows/macOS instructions must distinguish actually verified behavior from unverified platform assumptions.
3. Provide one setup sequence: prepare locked dependencies/assets, configure game paths, start Nexus, choose game, share game/board links, stop/switch, and troubleshoot an occupied port or failed game launch.
4. Document manifest/readiness version compatibility and future contract migration policy. Keep an entirely original demo/fixture and distributable library metadata; do not copy the personal games' copyrighted assets into Nexus.
5. Reconcile `docs/PLAN.md`, `README.md`, architecture, adapter acceptance results, and restart limitations. Decide remaining R5 license/contribution/public-project polish separately where it does not affect functional acceptance.

**Done:** both games can be played through one LAN portal; one-runtime switching and cleanup pass; phone-only and advertised display behavior pass; no game-specific logic enters Nexus; setup and supported-platform claims match actual evidence.

## N4 — Later friends-only remote-play milestone

**Dependencies:** accepted LAN release. This is a separate substantial milestone, governed by the existing `docs/REMOTE-PLAY.md` support gate.

Group its work into these bounded outcomes rather than starting certificates independently in each game:

1. Separate private administration and public player ingress; establish the supported Linux protected-ingress boundary and admin protections.
2. Launch games under a distinct security identity/sandbox with tested denial of control-plane/provider credentials and appropriate resource/crash-loop limits.
3. Complete public proxy/WS/SSE canonicalization, origin, framing, size/time/backpressure/cleanup behavior and client-attribution controls.
4. Resolve tunnel credential ownership/rotation/revocation, IPv4/IPv6 exposure, public disable/kill switches, and necessary network restrictions.
5. Deliver stable trusted HTTPS invite/link/QR UX, approximate presence/anomaly signals, idle shutdown, and documented operational support.
6. Verify every applicable existing remote support-gate item on one documented profile before claiming remote support. Then coordinate game secure-context checks and any separately promoted Pirate Shake work.

Deployment, tunnel/provider configuration, and detailed operations are separately scoped execution work after the accepted LAN baseline; the runtime contract remains portable.

## Starting files and verification ownership

Read `AGENTS.md`, `GAME-CONTRACT.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/GAME-AUTHORING-GUIDE.md`, and `docs/DEPLOYMENT-MODEL.md`. Read `docs/REMOTE-PLAY.md` for N4, not as a prerequisite to every LAN patch.

Core files: `src/registry.js`, `src/game-compatibility.js`, `src/server.js`, `src/game-proxy.js`, `src/runtime/supervisor.js`, `readiness.js`, `process-launcher.js`, private-port/process-group modules, and `public/app.js`. Existing focused tests include registry, compatibility, routing, server, readiness, launcher, supervisor, and process-group ownership coverage.

Use `npm run verify` for normal completion, game gates for game-owned behavior, and a real combined Nexus/browser/device campaign for the user-visible seam. Run `git diff --check` and inspect the scoped changes. These plans add no independent-agent roles, generated attestations, or workflow tooling requirements.

## Existing roadmap traceability

| Original scope | Execution grouping above |
|---|---|
| R0–R2 and schema-3 revision | Present on the adoption working tree; N0 verifies/finalizes the revised baseline |
| R3 real adapters | N1 plus the game-owned PI/CF milestones |
| R4 UX/resilience | N2; profile and metadata remain retained R4 work even if the first usable LAN release precedes them |
| R5 public-project polish | N3 release work plus the retained license/contribution/demo/support-documentation tasks |
| R6 remote play | N4; all detailed original support-gate obligations remain |

The original checkbox inventory below is preserved from the adoption working tree. It records implementation status on that tree; retaining an `[x]` is not a fresh test PASS. The execution milestones above refine sequencing, and do not drop unchecked product requirements. Do not mark all of R4 or R5 complete while their retained profile, metadata, license, contribution, or documented-platform tasks remain unfinished.

### Existing implementation inventory

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

- [x] Reverse-proxy HTTP under `/games/<id>/`, stripping the game `BASE_PATH` before forwarding to the private runtime except that any canonical post-prefix first path segment equal to ASCII `__nexus` case-insensitively is reserved and never player-proxyable.
- [x] Support WebSocket upgrades on the same game runtime/port.
- [x] Verify SSE/streaming behavior.
- [x] Reject invalid/unregistered game routes and any public path whose canonical post-prefix first segment is an ASCII case-insensitive match for `__nexus`, including encoded forms that canonicalize to such a case alias.
- [x] Add end-to-end routing tests against the fixture game, including lowercase `/games/<id>/__nexus/status`, direct mixed-case aliases such as `/games/<id>/__NEXUS/status` and `/games/<id>/__Nexus/status`, encoded mixed-case/canonicalization variants, unchanged ordinary game routes, near-name controls such as `/games/<id>/__nexusx/status` and `/games/<id>/__nexus-status`, and direct private Nexus readiness polling as a positive control.

## Contract revision gate before R3

The deliberately selected stricter common game shape is now promoted into the normative contract and implementation; real-game adapters may proceed.

- [x] Decide whether the remaining promoted behavioral requirements require a further contract/schema revision; do not silently redefine an already-supported contract version. (Schema 3.)
- [x] Promote the remaining selected runtime/browser/session requirements recorded in `docs/GAME-AUTHORING-GUIDE.md`, including same-origin browser behavior, service-worker containment, clean shutdown compatibility checks, server-authoritative shared state, session/recovery expectations where applicable, mandatory TV-less/standalone play, and the canonical optional `BASE_PATH/board/` entrypoint when dedicated-display support is advertised.
- [x] Define the future dedicated-display capability semantics so advertising dedicated-display support means the canonical public board entrypoint exists, while games that do not advertise it have no board-route requirement and every compatible game remains fully playable without that display.
- [x] Define the minimal optional Nexus player-presentation handoff: a reusable display name remains distinct from any opaque Nexus browser/profile ID, and neither replaces game-owned room/seat/reconnect identity or authorization.
- [x] Add reusable public landing/advertised-board availability and redirect-containment checks without teaching Nexus game rules or game-specific payloads. Broader browser/session/TV-less obligations require game-owned adapter acceptance in N1; the HTTP helper does not establish them.


### Retained remaining product scope

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
- [ ] Add the reusable Nexus player-presentation profile UX using the defined optional display-name handoff.
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

## Real-game roadmap ownership

- [Pirate Island](<../../pirate-island/PLAN.md>) owns its M7 acceptance, schema migration, room discovery, local assets, and game session/recovery behavior.
- [Captain Flip](<../../Captain Flip/docs/PLAN.md>) owns its single production runtime, one-table create/host flow, public paths, game authority, and optional board pairing.
- Both games implement [GAME-CONTRACT.md](../GAME-CONTRACT.md). Manifest schema 3 and readiness payload schema 2 must not be conflated.

Nexus must not create game-specific branches for rules, rooms, credentials, forecast, or dice semantics. Supporting a game does not make its personal/copyrighted content part of the Nexus project.
