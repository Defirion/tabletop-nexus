# Architecture

Tabletop Nexus is a local orchestration layer around independent browser games.

## Boundary

```text
browser(s)
   |
   v
+-------------------------------+
| Tabletop Nexus public server  |
| portal / registry / proxy     |
+-------------------------------+
               |
               v
        private game port
        selected game process
```

Nexus owns the browser-facing port. Games remain independent repositories/processes, bind to Nexus-selected private ports, and are exposed under `/games/<game-id>/` once R2 routing lands. The initial deployment policy keeps only one game runtime active at a time; multiple simultaneous runtimes remain a future capability.

## R0 components

### Registry

The registry reads local `nexus.config.json`, resolves configured game directories relative to that file, loads each `boardgame.json`, validates the current schema-2 contract, rejects duplicate public game IDs, and produces browser-safe metadata.

Two boundaries are deliberate:

1. a missing Nexus config means an empty library, while malformed config or a configured game with a missing/invalid manifest is an error;
2. filesystem roots and runtime launch details never cross the browser API boundary.

### Portal server

The Node HTTP server exposes:

- `GET`/`HEAD /healthz` — Nexus health;
- `GET`/`HEAD /api/games` — configured, validated game metadata;
- an allowlisted static portal at `/`, `/app.js`, and `/styles.css`.

R4 will connect lifecycle state and controls to the portal; the R1 supervisor itself is implemented independently of those UI routes.

## Runtime components

### Process supervisor (R1)

Private port allocation is an OS-assisted loopback allocator. Nexus probes `127.0.0.1` with port `0`, closes that probe before returning the lease so the game can bind the selected port, and keeps the port number logically claimed until the supervised runtime is known to have exited and the lease is released. An external process can still win the small probe-to-bind race. Nexus therefore does not treat a syntactically valid response from the assigned port as sufficient ownership evidence: every launch receives a fresh unpredictable `NEXUS_LAUNCH_TOKEN`, and readiness is accepted only when status-payload schema 2 echoes that exact token. The expected value is not sent in the readiness request, so a process that merely won the port cannot satisfy the association by reflecting request data.

The local/LAN launcher keeps manifest `runtime.command` and copied `runtime.args` separate through Node's child-process boundary, sets the configured game root as the working directory, explicitly disables shell execution, and overlays Nexus-owned `HOST`, `PORT`, `BASE_PATH`, and `NEXUS_LAUNCH_TOKEN` values on the inherited child environment. The Linux supervised launcher additionally overlays a fresh internal `NEXUS_LIFECYCLE_TOKEN` that runtime-owned helpers must inherit unchanged while they remain part of the launcher-owned runtime. Schema 2 requires the game to bind its browser-facing listener to the exact supplied private `HOST` and `PORT` and to echo the launch token only on its private Nexus readiness surface.

Supervised local children also have an explicit stdio policy: game stdin, stdout, and stderr are discarded rather than left as hidden unconsumed pipes. On Linux the small Nexus process-group controller uses a consumed IPC channel for lifecycle control; that channel is not game output and does not create an unowned backpressure surface. The direct local launch helper still pipes stdout/stderr because it returns the `ChildProcess` to a caller that can consume them. R4 logging must introduce an owned drain/collector path before changing the supervised policy; it must not reintroduce unconsumed pipes.

The supervisor-facing launch seam remains execution-mechanism agnostic. Launchers declare whether they retain Nexus's OS identity or establish a distinct security boundary. A deployment path that requires the stronger boundary fails closed before executing the same-identity local launcher, and supervisor lifecycle operations are routed through launcher methods rather than assuming every runtime is a Node `ChildProcess`.

For the Linux same-identity launcher, the lifecycle boundary is a dedicated process group/session anchored by a Nexus-owned controller. The controller is launched detached as the stable group leader and then launches the manifest-declared root inside that group with `shell: false`; ordinary runtime-owned helpers inherit the group and the per-launch lifecycle token. The controller ignores `SIGTERM` itself while issuing graceful group termination from inside the owned group, so the numeric PGID remains allocated while Nexus waits for runtime members to disappear. If the manifest root exits unexpectedly while descendants remain, the controller issues the residual forced group kill from inside that same generation. A forced `SIGKILL` necessarily terminates the controller too.

This controller anchor closes the destructive identity race around recyclable numeric PGIDs: Nexus no longer sends Linux group signals from outside the group after deciding ownership from a delayed numeric lookup. While the controller is alive, the controller itself prevents PGID reuse. After it exits, Nexus performs only liveness inspection and accepts a process as residue only when both its current PGID and inherited `NEXUS_LIFECYCLE_TOKEN` match the launch generation. A later unrelated process group that reuses the same number is therefore neither treated as runtime residue nor used as a destructive signal target. If the controller disappears unexpectedly before it can clean descendants, Nexus does not fall back to a later negative-PGID kill; it retains ownership only for descendants that still carry the launch-generation marker and waits for their actual exit. Permission/malformed/other ambiguous `/proc` inspection failures remain fail-closed rather than becoming exit evidence.

The complete-runtime contract therefore has two cooperating dependencies on Linux: runtime-owned helpers must remain in the launcher-owned group/session, and they must preserve the launcher-owned lifecycle token if they replace their inherited environment. A game that deliberately daemonizes, creates a new session/process group, or strips the lifecycle marker from a helper that still owns Nexus-assigned resources violates schema 2. Stronger non-escapable containment remains R6 work rather than being claimed by this same-identity mechanism.

Other local platforms do not use this Linux `/proc`-backed group-generation mechanism. The process-group implementation is deliberately limited to Linux rather than applying a recyclable numeric-group assumption on platforms where Nexus has no equivalent stable generation check. Future isolated launchers may use a service manager, cgroup/container, or another opaque lifecycle mechanism. The launcher security-boundary declaration is trusted implementation metadata, not proof that a remote deployment is secure. The actual supported remote launcher/sandbox and deployment-profile evidence remain R6 work and must establish the isolation properties in `DEPLOYMENT-MODEL.md` and `REMOTE-PLAY.md` from the real game execution context.

R1 also migrated the manifest contract from schema 1 to schema 2. Configurable `runtime.healthPath` is no longer part of the current contract. Nexus polls the fixed private `GET /__nexus/status` endpoint directly on the assigned host/port and accepts only HTTP `200` JSON using status-payload schema 2 with a boolean `ready` field and the exact per-launch token. A missing/mismatched token, invalid response, or old status schema remains not-ready until startup times out; process exit before readiness fails immediately. Each readiness probe has an absolute wall-clock deadline capped by the remaining startup budget and destroys its request when that deadline expires, so response activity cannot extend startup indefinitely.

The supervisor exposes game lifecycle states (`configured`, `starting`, `running`, `stopping`, `stopped`, `failed`) and the active private runtime endpoint for later R2 routing. Neither private launch-generation token is included in that public/routing snapshot. Default R1 timing is a 30-second startup timeout, 200 ms readiness polling interval, 1-second readiness request timeout, and 5-second graceful-stop period; tests and callers may override those values.

Only one runtime is active initially. Starting another game serially stops the current runtime, waits for any proxy connection setups already bound to that runtime, waits for complete-runtime termination, releases its port lease, and only then allocates/launches the replacement. Each proxy setup acquires an opaque reference only when the active runtime's full installed identity (resolved root plus manifest) matches the freshly loaded library entry; the reference is released after its private TCP connection is established or fails. This prevents a request from being connected to a replacement that reuses the old private port, and makes a live configuration change that reuses a public ID fail unavailable rather than proxying to a different game. On Linux the controller sends `SIGTERM` to its own runtime process group first and uses group `SIGKILL` after the grace period if necessary. The supervisor installs its definitive-exit observer immediately after launch, so a startup or stop cleanup failure retains the lease while any owned runtime process remains live but a later confirmed complete-runtime exit still releases the lease and active slot. Unexpected complete-runtime exit transitions the game to `failed` and releases the lease once exit is known.

The lifecycle regression suite uses a tiny original fixture runtime that consumes the real Nexus launch environment, binds the assigned private endpoint, echoes the per-launch readiness token, serves the fixed readiness surface, records graceful termination, can deliberately ignore `SIGTERM`, can trickle an unfinished readiness response, can emit output beyond ordinary pipe capacity before binding, can delegate the listener to a runtime-owned helper, and can deliberately fail readiness or crash. Linux process-group regressions cover graceful helper cleanup, forced switching where root/helper both ignore `SIGTERM`, and an unexpected-root-exit case where descendant cleanup is deliberately blocked: the lease remains owned and replacement is rejected until the surviving helper is actually terminated. A deterministic process-group generation regression also simulates the original group disappearing and an unrelated replacement reusing the same numeric PGID; the replacement lacks the lifecycle token, is not classified as runtime residue, and receives no parent-side numeric group signal. A deterministic racing responder separately occupies the assigned port with an otherwise valid status payload carrying the wrong readiness token, proving Nexus observes but never accepts that endpoint.

### Reverse proxy (R2)

Routes HTTP and upgrade/WebSocket traffic from `/games/<id>/...` to the correct active private game runtime. It must remain transport-agnostic and must not inspect game payloads.

The proxy resolves only a canonical raw game ID against the configured registry and routes only when that same game is the supervisor's active `running` runtime. The browser-facing game prefix is removed and the remaining path/query is forwarded to the private listener. `/games/<id>` redirects permanently to the canonical mount root `/games/<id>/`, preserving its query, so browser-relative resources remain within the game mount. Request and response bodies are streamed rather than buffered, so ordinary HTTP bodies, SSE, and other long-lived responses retain their transport behavior. A downstream disconnect is registered before target resolution and cancels any corresponding upstream request. If an upstream HTTP or rejected-upgrade response aborts, errors, or closes incomplete after headers, Nexus destroys the downstream response/socket rather than leaving it hung. WebSocket upgrades use the same route resolution and private runtime port; Node socket piping supplies backpressure, and Nexus removes WebSocket extension negotiation rather than enabling compression implicitly.

HTTP hop-by-hop fields are not forwarded. Client-supplied `Forwarded`, `X-Forwarded-*`, `CF-Connecting-IP`, and `CF-Ray` values are also removed at the current local/LAN boundary so games cannot mistake attacker-supplied attribution for Nexus-derived data. A future trusted-ingress attribution policy remains part of the R6 remote-play gate.

The private runtime-management namespace is a deliberate exception to prefix forwarding. After the same path canonicalization used for security decisions and removal of `/games/<id>`, Nexus treats a first path segment that equals ASCII `__nexus` **case-insensitively** as reserved. Therefore `/__nexus`, `/__NEXUS`, `/__Nexus`, and any encoded form that canonicalizes to one of those case aliases are never player-proxyable, whether the target is the segment itself or anything beneath it. Nexus uses the canonical lowercase namespace only across the private Nexus-to-game management seam, including `GET /__nexus/status`.

Nexus performs this decision on the raw request target before WHATWG URL dot-segment normalization. It splits raw path segments before percent-decoding once, rejects malformed encoding, encoded separators, nested escape sequences, controls, backslashes, duplicate separators, `.`/`..` segments, and matrix-parameter semicolons in every post-prefix segment, then compares the complete first post-prefix segment with an ASCII-only case fold. A literal decoded percent that is not the start of an escape sequence remains valid route data. The validated segments are re-encoded into the backend request target. The raw game-ID component itself must already be the canonical ASCII ID; encoded aliases are rejected. Rejecting matrix parameters across the whole post-prefix path prevents a backend router from stripping one before dot/empty-segment normalization can turn a player route into `__nexus`. This gives HTTP and WebSocket routing one path interpretation and fails closed on encoded separators, encoded traversal, matrix-normalization variants, and mixed-case/encoded management aliases while leaving distinct whole segments such as `__nexusx` and `__nexus-status` game-owned.

## Security model

The current implementation target is a trusted home LAN, not hostile multi-tenant hosting. Even so:

- configuration and runtime commands are server-side only;
- public static paths are allowlisted rather than mapped directly to arbitrary filesystem paths;
- manifests are local trusted configuration, not remotely supplied launch instructions;
- the local process launcher uses executable + argument arrays with explicit `shell: false` rather than shell interpolation;
- supervisor-owned `HOST`/`PORT`/`BASE_PATH`/`NEXUS_LAUNCH_TOKEN` values override inherited names at the launch boundary;
- the Linux local launcher also overrides `NEXUS_LIFECYCLE_TOKEN` with a fresh per-launch value before starting its lifecycle controller;
- the per-launch readiness token stays inside the launch environment/private management surface and is not exposed in the active-runtime snapshot;
- the lifecycle token is not player/game authorization and is not exposed through Nexus's public API;
- supervised local output has an explicit non-blocking disposition rather than unconsumed hidden pipes;
- the Linux local launcher contains ordinary runtime-owned descendants in a controller-anchored process group and does not release lifecycle ownership while live members from that launch generation remain;
- destructive Linux group signals originate inside the still-owned group, so later numeric PGID reuse cannot redirect them to an unrelated group;
- the supervisor-facing launch seam does not assume a same-identity child and can reject that mechanism before execution when a distinct security boundary is required;
- invalid or unregistered public game routes must be rejected;
- the reserved private game-management first path segment must never be forwarded from a player route under any ASCII case alias after canonicalization.

Friends-only internet exposure is planned separately in [`REMOTE-PLAY.md`](REMOTE-PLAY.md). That design deliberately keeps players unauthenticated initially, adds a stronger public-ingress threat model and private admin boundary, and is not considered supported until its documented acceptance gate passes.

## Design rule

**Nexus knows how to run games; Nexus does not know how games work.**

A new game integrates by satisfying `GAME-CONTRACT.md`, not by adding game-specific logic to Nexus.
