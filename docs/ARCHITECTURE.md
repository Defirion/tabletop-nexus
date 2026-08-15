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

The local/LAN launcher keeps manifest `runtime.command` and copied `runtime.args` separate through Node's child-process boundary, sets the configured game root as the working directory, explicitly disables shell execution, and overlays Nexus-owned `HOST`, `PORT`, `BASE_PATH`, and `NEXUS_LAUNCH_TOKEN` values on the inherited child environment. Schema 2 requires the game to bind its browser-facing listener to the exact supplied private `HOST` and `PORT` and to echo the launch token only on its private Nexus readiness surface.

Supervised local children also have an explicit stdio policy: stdin, stdout, and stderr are discarded rather than left as hidden unconsumed pipes. That prevents ordinary game output from becoming a backpressure dependency that can stall readiness or runtime progress. The direct local launch helper still pipes stdout/stderr because it returns the `ChildProcess` to a caller that can consume them. R4 logging must introduce an owned drain/collector path before changing the supervised policy; it must not reintroduce unconsumed pipes.

The supervisor-facing launch seam remains execution-mechanism agnostic. Launchers declare whether they retain Nexus's OS identity or establish a distinct security boundary. A deployment path that requires the stronger boundary fails closed before executing the same-identity local launcher, and supervisor lifecycle operations are routed through launcher methods rather than assuming every runtime is a Node `ChildProcess`.

For the local Unix launcher, the supervisor-facing lifecycle boundary is a dedicated process group rooted at the manifest-launched process. Normal runtime-owned helpers inherit that group. Stop signals are sent to the whole group, and `waitForExit()` does not settle merely because the root `ChildProcess` closed: it waits until no live group member remains. On Linux, group liveness is checked through `/proc` so already-terminated zombies do not turn graceful shutdown into a false forced-stop result. If the root exits unexpectedly while descendants remain, the launcher attempts to kill that residual group before reporting complete-runtime termination. Failure to signal or inspect the group is not treated as proof that the runtime is gone, so the supervisor retains the active record and private-port lease until termination is actually established.

That process-group mechanism is specific to the same-identity local Unix implementation; future isolated launchers may use a service manager, cgroup/container, or another opaque lifecycle mechanism. The launcher security-boundary declaration is trusted implementation metadata, not proof that a remote deployment is secure. The actual supported remote launcher/sandbox and deployment-profile evidence remain R6 work and must establish the isolation properties in `DEPLOYMENT-MODEL.md` and `REMOTE-PLAY.md` from the real game execution context.

R1 also migrated the manifest contract from schema 1 to schema 2. Configurable `runtime.healthPath` is no longer part of the current contract. Nexus polls the fixed private `GET /__nexus/status` endpoint directly on the assigned host/port and accepts only HTTP `200` JSON using status-payload schema 2 with a boolean `ready` field and the exact per-launch token. A missing/mismatched token, invalid response, or old status schema remains not-ready until startup times out; process exit before readiness fails immediately. Each readiness probe has an absolute wall-clock deadline capped by the remaining startup budget and destroys its request when that deadline expires, so response activity cannot extend startup indefinitely.

The supervisor exposes game lifecycle states (`configured`, `starting`, `running`, `stopping`, `stopped`, `failed`) and the active private runtime endpoint for later R2 routing. The private launch token is never included in that public/routing snapshot. Default R1 timing is a 30-second startup timeout, 200 ms readiness polling interval, 1-second readiness request timeout, and 5-second graceful-stop period; tests and callers may override those values.

Only one runtime is active initially. Starting another game serially stops the current runtime, waits for complete-runtime termination, releases its port lease, and only then allocates/launches the replacement. On Linux the local launcher sends `SIGTERM` to the runtime process group first and uses group `SIGKILL` after the grace period if necessary. The supervisor installs its definitive-exit observer immediately after launch, so a startup or stop cleanup failure retains the lease while any owned runtime process remains live but a later confirmed complete-runtime exit still releases the lease and active slot. Unexpected complete-runtime exit transitions the game to `failed` and releases the lease once exit is known.

The lifecycle regression suite uses a tiny original fixture runtime that consumes the real Nexus launch environment, binds the assigned private endpoint, echoes the per-launch readiness token, serves the fixed readiness surface, records graceful termination, can deliberately ignore `SIGTERM`, can trickle an unfinished readiness response, can emit output beyond ordinary pipe capacity before binding, can delegate the listener to a runtime-owned helper, and can deliberately fail readiness or crash. Linux process-group regressions cover graceful helper cleanup, forced switching where root/helper both ignore `SIGTERM`, and an unexpected-root-exit case where descendant cleanup is deliberately blocked: the lease remains owned and replacement is rejected until the surviving helper is actually terminated. A deterministic racing responder separately occupies the assigned port with an otherwise valid status payload carrying the wrong token, proving Nexus observes but never accepts that endpoint.

### Reverse proxy (R2)

Routes HTTP and upgrade/WebSocket traffic from `/games/<id>/...` to the correct active private game runtime. It must remain transport-agnostic and must not inspect game payloads.

The private runtime-management namespace is a deliberate exception to prefix forwarding. After the same path canonicalization used for security decisions and removal of `/games/<id>`, Nexus treats a first path segment that equals ASCII `__nexus` **case-insensitively** as reserved. Therefore `/__nexus`, `/__NEXUS`, `/__Nexus`, and any encoded form that canonicalizes to one of those case aliases are never player-proxyable, whether the target is the segment itself or anything beneath it. Nexus uses the canonical lowercase namespace only across the private Nexus-to-game management seam, including `GET /__nexus/status`.

## Security model

The current implementation target is a trusted home LAN, not hostile multi-tenant hosting. Even so:

- configuration and runtime commands are server-side only;
- public static paths are allowlisted rather than mapped directly to arbitrary filesystem paths;
- manifests are local trusted configuration, not remotely supplied launch instructions;
- the local process launcher uses executable + argument arrays with explicit `shell: false` rather than shell interpolation;
- supervisor-owned `HOST`/`PORT`/`BASE_PATH`/`NEXUS_LAUNCH_TOKEN` values override inherited names at the launch boundary;
- the per-launch readiness token stays inside the launch environment/private management surface and is not exposed in the active-runtime snapshot;
- supervised local output has an explicit non-blocking disposition rather than unconsumed hidden pipes;
- the local Unix launcher contains ordinary runtime-owned descendants in a dedicated process group and does not release lifecycle ownership while live group members remain;
- the supervisor-facing launch seam does not assume a same-identity child and can reject that mechanism before execution when a distinct security boundary is required;
- invalid or unregistered public game routes must be rejected;
- the reserved private game-management first path segment must never be forwarded from a player route under any ASCII case alias after canonicalization.

Friends-only internet exposure is planned separately in [`REMOTE-PLAY.md`](REMOTE-PLAY.md). That design deliberately keeps players unauthenticated initially, adds a stronger public-ingress threat model and private admin boundary, and is not considered supported until its documented acceptance gate passes.

## Design rule

**Nexus knows how to run games; Nexus does not know how games work.**

A new game integrates by satisfying `GAME-CONTRACT.md`, not by adding game-specific logic to Nexus.
