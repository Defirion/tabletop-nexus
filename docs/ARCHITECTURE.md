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

Nexus owns the browser-facing port. Games remain independent repositories/processes, bind to Nexus-selected private ports, and are exposed under `/games/<game-id>/` by the implemented R2 proxy. The initial deployment policy keeps only one game runtime active at a time; multiple simultaneous runtimes remain a future capability.

## R0 components

### Registry

The registry reads local `nexus.config.json`, resolves configured game directories relative to that file, loads each `boardgame.json`, validates the current schema-3 contract, rejects duplicate public game IDs, and produces browser-safe metadata.

Two boundaries are deliberate:

1. a missing Nexus config means an empty library, while malformed config or a configured game with a missing/invalid manifest is an error;
2. filesystem roots and runtime launch details never cross the browser API boundary.

Only schema-3 manifests are accepted; older configured games fail the library load until migrated or removed from local configuration. No automatic manifest upgrade occurs. The manifest version is independent of private readiness payload schema 2. The explicit `verifyPublicGameCompatibility` adapter check verifies landing/advertised-board HTTP availability and contained redirects using the proxy's path parser; it is not automatic readiness or game/session validation.

### Portal server

The Node HTTP server exposes:

- `GET`/`HEAD /healthz` — Nexus health;
- `GET`/`HEAD /api/games` — configured, validated game metadata, current lifecycle state, ready public links, an allowlisted active-runtime summary, and whether a portal action is in progress;
- `POST /api/games/<id>/start` — start a configured game or switch through the existing supervisor;
- `POST /api/games/<id>/stop` — stop that game only if it is still active, including when its registration has been removed or local configuration is invalid;
- an allowlisted static portal at `/`, `/qr.js`, `/app.js`, `/styles.css`, and its bundled `/fonts/*.woff2` files, so the portal makes no third-party requests. `qr.js` is a small dependency-free QR generator (byte mode, error-correction level M, versions 1-10, so links up to 213 UTF-8 bytes) that runs in the browser: link text is never sent to a third-party QR service. The portal encodes the same public-origin URLs it offers as links, so the code is only as reachable as the address the host used to open the portal; it warns when that address is loopback.

The portal connects start/stop/switch controls to the supervisor. It polls every second while visible, pauses controls and ready links when library refresh fails, and asks the host to confirm ending an active session before stop/switch/restart. Unchanged polling responses preserve focused DOM controls. Links use the current public Nexus origin; dedicated-display links appear only for an advertised capability on an identity-matched ready runtime. A changed runtime command/root cannot retain an Open link merely because the game ID matches.

Lifecycle POSTs require `X-Nexus-Action: 1`. When present, `Origin` must match the HTTP request's Nexus origin and `Sec-Fetch-Site` must be `same-origin`; no CORS grant is provided. Start also requires `X-Nexus-Active-Game` equal to the currently observed active game ID (an empty value for no active game). This prevents a stale tab from switching away from a different active game. Repeated Start of the same identity-matched ready installation is idempotent. Overlapping portal actions return `409 LIFECYCLE_BUSY` rather than building a queue of browser requests. Targeted Stop checks the expected game ID inside the supervisor's serialized operation, so a queued switch cannot cause it to stop a different game.

The public API never copies supervisor error strings or private runtime endpoints. Failures return stable error codes and a safe player/host summary; detailed action failures remain in the Nexus host console. A failed runtime whose cleanup is unresolved retains its active summary and offers Stop while the portal disables new starts. Runtime stdout/stderr collection remains future diagnostic work under the stdio ownership rule below.

These are trusted LAN host controls: anyone who can use the portal can operate them, including same-origin game code. The custom header/origin checks prevent ordinary cross-origin browser submissions; they do not establish host identity or the separate private administration boundary required for remote play. N4 remains unsupported. Rooms remain game-owned. Lifecycle state lives in the supervisor's memory, plus the ownership record described under [Restart behavior](#restart-behavior); a Nexus restart ends the live game and never resumes it.

`GET /api/games` adds two optional restart-recovery fields only when they apply: `runtime.recovered: true` marks a runtime left behind by a previous Nexus process (a leftover being cleaned up, or one that could not be confirmed stopped), and a top-level `recovery: { status: "blocked", message }` means a stored ownership record could not be interpreted at all. The `RECOVERY_BLOCKED` action error (409) refuses starts in that state. Process ids, paths, tokens and ownership evidence never appear in the API; the Nexus host console carries the specifics.

## Runtime components

### Process supervisor (R1)

Private port allocation is an OS-assisted loopback allocator. Nexus probes `127.0.0.1` with port `0`, closes that probe before returning the lease so the game can bind the selected port, and keeps the port number logically claimed until the supervised runtime is known to have exited and the lease is released. An external process can still win the small probe-to-bind race. Nexus therefore does not treat a syntactically valid response from the assigned port as sufficient ownership evidence: every launch receives a fresh unpredictable `NEXUS_LAUNCH_TOKEN`, and readiness is accepted only when status-payload schema 2 echoes that exact token. The expected value is not sent in the readiness request, so a process that merely won the port cannot satisfy the association by reflecting request data.

The local/LAN launcher keeps manifest `runtime.command` and copied `runtime.args` separate through Node's child-process boundary, sets the configured game root as the working directory, explicitly disables shell execution, and overlays Nexus-owned `HOST`, `PORT`, `BASE_PATH`, and `NEXUS_LAUNCH_TOKEN` values on the inherited child environment. The Linux supervised launcher additionally overlays a fresh internal `NEXUS_LIFECYCLE_TOKEN` that runtime-owned helpers must inherit unchanged while they remain part of the launcher-owned runtime. Schema 3 requires the game to bind its browser-facing listener to the exact supplied private `HOST` and `PORT`, echo the launch token only on its private Nexus readiness surface, and meet the promoted browser/session behavior in `GAME-CONTRACT.md`.

Supervised local children also have an explicit stdio policy: game stdin, stdout, and stderr are discarded rather than left as hidden unconsumed pipes. On Linux the small Nexus process-group controller uses a consumed IPC channel for lifecycle control; that channel is not game output and does not create an unowned backpressure surface. The direct local launch helper still pipes stdout/stderr because it returns the `ChildProcess` to a caller that can consume them. R4 logging must introduce an owned drain/collector path before changing the supervised policy; it must not reintroduce unconsumed pipes.

The supervisor-facing launch seam remains execution-mechanism agnostic. Launchers declare whether they retain Nexus's OS identity or establish a distinct security boundary. A deployment path that requires the stronger boundary fails closed before executing the same-identity local launcher, and supervisor lifecycle operations are routed through launcher methods rather than assuming every runtime is a Node `ChildProcess`.

For the Linux same-identity launcher, the lifecycle boundary is a dedicated process group/session anchored by a Nexus-owned controller. The controller is launched detached as the stable group leader. It starts inert: the manifest-declared root is launched inside that group (with `shell: false`) only after Nexus has durably recorded this controller's identity and sent a `start` message, so there is no instant at which a runtime exists that restart recovery could not name. Ordinary runtime-owned helpers inherit the group and the per-launch lifecycle token. The controller ignores `SIGTERM` itself while issuing graceful group termination from inside the owned group, so the numeric PGID remains allocated while Nexus waits for runtime members to disappear. If the manifest root exits unexpectedly while descendants remain, the controller issues the residual forced group kill from inside that same generation. A forced `SIGKILL` necessarily terminates the controller too.

This controller anchor closes the destructive identity race around recyclable numeric PGIDs: Nexus no longer sends Linux group signals from outside the group after deciding ownership from a delayed numeric lookup. While the controller is alive, the controller itself prevents PGID reuse. After it exits, Nexus performs only liveness inspection and accepts a process as residue only when both its current PGID and inherited `NEXUS_LIFECYCLE_TOKEN` match the launch generation. A later unrelated process group that reuses the same number is therefore neither treated as runtime residue nor used as a destructive signal target. If the controller disappears unexpectedly before it can clean descendants, Nexus does not fall back to a later negative-PGID kill; it retains ownership only for descendants that still carry the launch-generation marker and waits for their actual exit. Permission/malformed/other ambiguous `/proc` inspection failures remain fail-closed rather than becoming exit evidence.

The complete-runtime contract therefore has two cooperating dependencies on Linux: runtime-owned helpers must remain in the launcher-owned group/session, and they must preserve the launcher-owned lifecycle token if they replace their inherited environment. A game that deliberately daemonizes, creates a new session/process group, or strips the lifecycle marker from a helper that still owns Nexus-assigned resources violates schema 3. Stronger non-escapable containment remains R6 work rather than being claimed by this same-identity mechanism.

Other local platforms do not use this Linux `/proc`-backed group-generation mechanism. The process-group implementation is deliberately limited to Linux rather than applying a recyclable numeric-group assumption on platforms where Nexus has no equivalent stable generation check. Future isolated launchers may use a service manager, cgroup/container, or another opaque lifecycle mechanism. The launcher security-boundary declaration is trusted implementation metadata, not proof that a remote deployment is secure. The actual supported remote launcher/sandbox and deployment-profile evidence remain R6 work and must establish the isolation properties in `DEPLOYMENT-MODEL.md` and `REMOTE-PLAY.md` from the real game execution context.

R1 migrated the manifest contract from schema 1 to schema 2; the pre-R3 gate then migrated it to schema 3 for the promoted browser/session requirements. Configurable `runtime.healthPath` is no longer part of the current contract. Nexus polls the fixed private `GET /__nexus/status` endpoint directly on the assigned host/port and accepts only HTTP `200` JSON using status-payload schema 2 with a boolean `ready` field and the exact per-launch token. A missing/mismatched token, invalid response, or old status schema remains not-ready until startup times out; process exit before readiness fails immediately. Each readiness probe has an absolute wall-clock deadline capped by the remaining startup budget and destroys its request when that deadline expires, so response activity cannot extend startup indefinitely.

The supervisor exposes game lifecycle states (`configured`, `starting`, `running`, `stopping`, `stopped`, `failed`) and the active private runtime endpoint for later R2 routing. Neither private launch-generation token is included in that public/routing snapshot. Default R1 timing is a 30-second startup timeout, 200 ms readiness polling interval, 1-second readiness request timeout, and 5-second graceful-stop period; tests and callers may override those values.

Only one runtime is active initially. Starting another game serially stops the current runtime, waits for any proxy connection setups already bound to that runtime, waits for complete-runtime termination, releases its port lease, and only then allocates/launches the replacement. Each proxy setup acquires an opaque reference only when the active runtime's installed identity matches the freshly loaded library entry: resolved root, game ID (which determines the public base path), and `runtime.command`/`runtime.args` (which determine the launched process). Descriptive and unknown schema-3 manifest fields are not identity-significant. The reference is released after its private TCP connection is established or fails. This prevents a request from being connected to a replacement that reuses the old private port, and makes a live configuration change that reuses a public ID fail unavailable rather than proxying to a different game. On Linux the controller sends `SIGTERM` to its own runtime process group first and uses group `SIGKILL` after the grace period if necessary. The supervisor installs its definitive-exit observer immediately after launch, so a startup or stop cleanup failure retains the lease while any owned runtime process remains live but a later confirmed complete-runtime exit still releases the lease and active slot. Unexpected complete-runtime exit transitions the game to `failed` and releases the lease once exit is known.

The lifecycle regression suite uses a tiny original fixture runtime that consumes the real Nexus launch environment, binds the assigned private endpoint, echoes the per-launch readiness token, serves the fixed readiness surface, records graceful termination, can deliberately ignore `SIGTERM`, can trickle an unfinished readiness response, can emit output beyond ordinary pipe capacity before binding, can delegate the listener to a runtime-owned helper, and can deliberately fail readiness or crash. Linux process-group regressions cover graceful helper cleanup, forced switching where root/helper both ignore `SIGTERM`, and an unexpected-root-exit case where descendant cleanup is deliberately blocked: the lease remains owned and replacement is rejected until the surviving helper is actually terminated. A deterministic process-group generation regression also simulates the original group disappearing and an unrelated replacement reusing the same numeric PGID; the replacement lacks the lifecycle token, is not classified as runtime residue, and receives no parent-side numeric group signal. A deterministic racing responder separately occupies the assigned port with an otherwise valid status payload carrying the wrong readiness token, proving Nexus observes but never accepts that endpoint.

### Restart behavior

**A Nexus restart ends the live game. It never adopts or resumes one.** Rooms and seats are game-owned and in memory, so there is nothing seamless to resume; the design goal is that after any restart the portal tells the truth and no game process is left running unsupervised.

*Orderly restart.* `SIGINT`/`SIGTERM` on Nexus stops accepting connections and ends the active game through the normal supervised graceful stop (`SIGTERM`, grace period, forced fallback), then exits. Nothing is left behind and the next start finds an empty ownership record. The portal's own **Stop game** remains the way to end a session deliberately before restarting.

*Crash or kill.* The launch-time controller owns its runtime and watches its IPC channel to Nexus. If Nexus vanishes without an orderly stop (`SIGKILL`, crash, OOM), the controller removes its runtime itself, from inside its own group: `SIGTERM`, then `SIGKILL` after the grace period, or immediately once the root has exited, so residual helpers do not survive. The cleanup therefore never depends on a restarted Nexus signalling anything, and the numeric-identifier-reuse rule above is unchanged: **a restarted Nexus never sends a signal to a process it did not just launch.** A controller that never received its `start` message launched nothing and simply exits.

*Ownership record.* So a restarted Nexus can tell the truth about what it finds, the supervisor writes a single-slot record before the runtime starts (write-ahead; if the write fails the launch is aborted and no runtime exists) and removes it only at the point where termination is confirmed and the lease released. It stores the game id, private port, launch phase, and the launcher's generation descriptor (on Linux: controller pid = process-group id and the per-launch `NEXUS_LIFECYCLE_TOKEN`). The file is a fixed name in a per-user state directory (`NEXUS_STATE_DIR`, default `$TMPDIR/tabletop-nexus-<uid>`, created `0700` and refused if it is a symlink, foreign-owned or group/world accessible; the record is `0600` and replaced atomically). The default suits the read-only-root container profile because everything the record describes dies with a reboot or container recreation. The record is evidence to verify, never authority: it names no process by id alone.

*Recovery at startup.* Before serving any lifecycle state, Nexus reads the record and asks the launcher whether that generation is still present. The check is read-only and generation-aware, the same rule used after a controller exits: a process counts only if its process group **and** its inherited lifecycle token match, so a recycled group number is never residue. Outcomes:

| Finding | Portal | Next step |
|---|---|---|
| No record | Nothing on the table | Normal start |
| Generation absent | Nothing on the table | Record cleared (the controller finished its cleanup) |
| Present, controller alive | The game shows **Stopping** and `runtime.recovered` | Resolves by itself when the controller finishes; starting another game waits for it |
| Present, controller gone, or not gone after the recovery deadline, or the check is ambiguous (unreadable `/proc`, malformed record, launcher cannot verify) | The game shows **Failed** and `runtime.recovered`; starts are paused | Nothing is signalled. The host console says what to stop; the state clears by itself once the processes are gone |
| Record unreadable (damaged, unknown version, not a regular file) | `recovery.status: "blocked"`; starts refused | Console says to check for a leftover game and delete the record file; Nexus notices on its own |

A leftover runtime occupies the single active slot and keeps its private port claimed until it is confirmed gone, so one-game-at-a-time and the lease rule hold across a restart exactly as they do within one process. A leftover is never routable: it has no installed identity, so no proxy reference or Open link can attach to it, even for a game with the same id. Unresolved or ambiguous ownership is never converted into "gone", and the lease is never erased to look healthy.

*Interrupted launch.* Crashing between recording and starting leaves an inert controller that exits; crashing after the start leaves a runtime its controller removes. Either way the record is verified and cleared as above. A launch that fails after recording but before a runtime handle exists clears its own record.

*Other platforms.* Only the Linux process-group launcher can prove ownership of a surviving runtime, so only it writes a record. On Windows and macOS a surviving game after a Nexus crash cannot be identified or reported; orderly shutdown still stops the game, and the README tells hosts to stop games before killing Nexus there. This limitation is deliberate rather than guessing from an operating-system id.

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
- destructive Linux group signals originate inside the still-owned group, so later numeric PGID reuse cannot redirect them to an unrelated group; this includes cleanup after Nexus itself dies, which the controller performs on its own, and a restarted Nexus only inspects and never signals;
- the runtime ownership record is written before the runtime exists, in an owner-only state directory, is evidence that must be re-verified against the live system, and is removed only once termination is confirmed;
- unverifiable or ambiguous leftover ownership keeps the single active slot and the private-port claim and blocks replacement;
- the supervisor-facing launch seam does not assume a same-identity child and can reject that mechanism before execution when a distinct security boundary is required;
- invalid or unregistered public game routes must be rejected;
- the reserved private game-management first path segment must never be forwarded from a player route under any ASCII case alias after canonicalization.

Friends-only internet exposure is planned separately in [`REMOTE-PLAY.md`](REMOTE-PLAY.md). That design deliberately keeps players unauthenticated initially, adds a stronger public-ingress threat model and private admin boundary, and is not considered supported until its documented acceptance gate passes.

## Design rule

**Nexus knows how to run games; Nexus does not know how games work.**

A new game integrates by satisfying `GAME-CONTRACT.md`, not by adding game-specific logic to Nexus.
