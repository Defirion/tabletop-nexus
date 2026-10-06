# Tabletop Nexus game contract

This document defines the smallest interface a browser game must implement to be discoverable and launchable by Tabletop Nexus.

The boundary is runtime integration, not game design: **Nexus knows how to run games; Nexus does not know how games work.**

## Contract version

Current manifest schema: `3`.

Schema 3 promotes the browser/runtime compatibility requirements deliberately deferred after schema 2: same-origin and base-path-safe browser behavior, service-worker containment, clean shutdown, server-authoritative shared state, normal session recovery where applicable, and the canonical optional dedicated-display entrypoint. Schema 2 remains the status-payload schema for the private readiness surface; it is not a manifest schema.

Manifest schemas 1 and 2 are no longer accepted by the current validator. This is an explicit contract migration rather than a silent redefinition of an already-supported contract.

Existing schema-2 registrations fail validation until their game repository implements the schema-3 obligations and updates its manifest. Nexus does not upgrade manifests automatically. An invalid configured manifest currently fails the library load (including `/api/games`); remove that registration temporarily or migrate the game before using the revised library. This includes Pirate Island's existing schema-2 adapter. Readiness payloads remain schema 2 and must not be changed to 3 during this migration.

Compatible games expose `boardgame.json` at the game repository root:

```json
{
  "schema": 3,
  "id": "example-game",
  "name": "Example Game",
  "description": "A short library-card description.",
  "players": { "min": 2, "max": 5 },
  "capabilities": {
    "tvLess": true,
    "personalDevices": true,
    "dedicatedDisplay": false
  },
  "runtime": {
    "command": "node",
    "args": ["server.js"]
  }
}
```

## Required manifest fields

- `schema`: contract schema version. Currently `3`.
- `id`: stable lowercase identifier using letters, numbers, and single hyphens between segments.
- `name`: non-empty human-readable title.
- `players.min` / `players.max`: positive integers with `max >= min`.
- `capabilities.tvLess`: **must be `true`**.
- `runtime.command`: non-empty executable name or path that Nexus launches directly, without a shell.
- `runtime.args`: array of argument strings passed directly to the executable.

`runtime.command` must identify a program the target operating system can execute directly. It is not a command line: shell built-ins, pipelines, redirects, or strings such as `npm run start:nexus` do not belong in this field. Keep every argument in `runtime.args`. Platform command shims that themselves require a shell are not portable Nexus launch targets; use the underlying executable entrypoint instead.

`description` is an optional string. `capabilities.personalDevices` and `capabilities.dedicatedDisplay` are optional booleans. When `dedicatedDisplay` is `true`, it is also a compatibility promise: the game must provide the canonical public `BASE_PATH/board/` entrypoint described below. Games that omit it or set it to `false` have no board-route requirement. Unknown fields are ignored by schema 3 so games may carry their own metadata without widening Nexus's responsibility. A `runtime.healthPath` field has no Nexus meaning in schema 3; Nexus always polls the fixed readiness surface below.

## Public versus private metadata

The manifest is server-side runtime configuration. Nexus may expose these fields to browsers:

- `id`, `name`, `description`;
- `players`;
- `capabilities`;
- Nexus-owned lifecycle status.

Nexus must not expose configured filesystem roots, `runtime.command`, `runtime.args`, or the per-launch readiness token through its public API. Runtime details are execution authority, not library-card metadata.

## Runtime environment and private bind

Nexus launches the declared command with the game repository as the working directory and supplies:

- `HOST`: Nexus-selected private bind host;
- `PORT`: Nexus-selected private port;
- `BASE_PATH`: canonical public route assigned to the game, `/games/<game-id>`, without a trailing slash;
- `NEXUS_LAUNCH_TOKEN`: opaque unpredictable value generated separately for each launch and used only to associate the private readiness response with that launched runtime;
- `NEXUS_LIFECYCLE_TOKEN`: opaque launcher-owned per-launch value used only by the same-identity Linux lifecycle boundary to distinguish runtime-owned descendants from a later process group that reuses the same numeric identifier.

The runtime must bind its browser-facing listener to the exact supplied `HOST` and `PORT`. It must not widen the bind to `0.0.0.0`, `::`, or another interface in Nexus mode. If the assigned bind cannot be satisfied, startup must fail rather than choosing another address or fixed port.

`NEXUS_LAUNCH_TOKEN` is not game/session identity and is not authorization for player actions. The runtime must keep it on the private Nexus management seam and echo it only in the readiness payload described below. Nexus does not send the expected token in its readiness request, so a different process that merely wins the assigned port cannot satisfy readiness by reflecting request data.

`NEXUS_LIFECYCLE_TOKEN` is likewise not game/session identity or authorization. Games do not interpret or expose it. Runtime-owned helpers must inherit it unchanged while they remain part of the launcher-owned runtime; replacing a helper's environment must preserve this value. Nexus uses it only as local lifecycle-generation evidence after the Linux process-group controller has exited.

### Base-path behavior

A game must work when mounted below `BASE_PATH`, not only at `/`. Browser navigation, static assets, API calls, WebSockets/SSE, redirects, generated links, and cookie paths must remain on the public Nexus origin within the assigned public base path. Browser code must not construct direct private-port, LAN-host, or development-server URLs in Nexus mode.

Nexus may strip the public game prefix while proxying requests, but the browser-facing application must still generate URLs that remain under `BASE_PATH`.

If a game uses a service worker, its registration scope must be contained within `BASE_PATH/`; it must not control the Nexus portal or a sibling game's paths. A runtime that serves files from disk must expose an explicit public build/static root, never the game repository root or arbitrary server files.

## One-process LAN runtime

The launch command must produce one self-contained game runtime from Nexus's perspective: one Nexus-owned lifecycle boundary and one private browser-facing HTTP port. The root process may use helpers internally, but every runtime-owned descendant must remain inside the lifecycle boundary owned by the launcher and inherit the launcher-owned `NEXUS_LIFECYCLE_TOKEN` unchanged. A runtime must not daemonize, create a new session/process group, strip that lifecycle marker from a runtime-owned helper, or otherwise move helpers outside the boundary while they retain Nexus-assigned runtime state or resources.

The runtime is responsible for serving its frontend and browser-facing HTTP/WebSocket/SSE endpoints. Development servers are not part of the runtime contract.

## Nexus readiness surface

Every schema-3 runtime must expose this private endpoint on the assigned `HOST` and `PORT`:

```http
GET /__nexus/status
```

A well-formed response returns HTTP `200`, `Content-Type: application/json`, and a JSON object using status-payload schema 2:

```json
{
  "schema": 2,
  "ready": true,
  "launchToken": "<exact NEXUS_LAUNCH_TOKEN value>"
}
```

Status-payload schema 2 replaces the earlier payload schema 1 because readiness now establishes both player-readiness and association with the specific runtime Nexus launched. Payload schema 1 is not accepted by the current readiness client.

`ready` has one platform meaning: **Nexus may route players to this runtime.**

Requirements:

- `schema` is the integer status-payload schema version and is currently `2`;
- `ready` is a required boolean;
- `launchToken` is required and must exactly equal the `NEXUS_LAUNCH_TOKEN` supplied to that runtime at launch;
- `ready: false` is a valid response meaning the associated runtime is alive but not yet player-ready;
- unknown fields are ignored when the status schema is supported;
- the endpoint requires no player authentication or game state, is side-effect free, and returns promptly.

A response with a missing or mismatched launch token is not ready even if every other field is valid and `ready` is `true`. Timeouts, connection failures, non-`200` responses, non-JSON content, malformed JSON, unsupported status schemas, or missing/invalid required fields are likewise treated as not ready. Nexus never consults a manifest-configured readiness path.

The `__nexus` first path segment is private runtime-management space. R2 reserves that segment case-insensitively after canonicalization so the readiness surface cannot be reached through a public player route.

Games may keep independent diagnostics such as `/healthz` or metrics endpoints; Nexus does not interpret them.

## Player experience, sessions, and authority

Every compatible game has a server-authoritative shared-state model: browsers submit intent/input and render a game-provided projection, while the runtime remains the source of truth for the shared board. Nexus does not inspect the state, actions, or payloads.

When a game has multiplayer sessions or rooms, its normal landing page must expose game-owned joinable sessions and a way to create a session. It must recover the current game experience after an ordinary browser refresh or transient network interruption without requiring the original HTTP, WebSocket, or SSE connection to survive. Exact room, seat, reconnect-token, and authorization mechanisms remain game-owned.

## TV-less and dedicated-display requirements

Every compatible game must be completely playable **without a dedicated TV/display client**. A game may use a shared browser, individual player devices, a combined host/player view, or another layout that preserves the complete experience without a separate display.

A dedicated table display may be supported with `capabilities.dedicatedDisplay: true`. That promise requires a canonical public `BASE_PATH/board/` entrypoint, served by the same supervised runtime and private port. The board may present game-owned room selection or pairing before it attaches to a session, but it must not be a required device or contain controls/information necessary for complete TV-less play.

## Nexus player-presentation handoff

Nexus may later offer a browser-local presentation profile with an editable, non-unique display name and an opaque Nexus browser/profile identifier. The minimal game-facing handoff is **only an optional display-name suggestion**; games may use it as a default in their own create/join UI and must continue to work when it is absent.

The opaque Nexus profile identifier is never supplied as a game seat, room, reconnect credential, or authorization token. A game must issue and validate its own identity and recovery authority. Nexus's future profile UX and transport details are platform-owned and may evolve independently; until that UX exists, games must not rely on a Nexus profile being present.

## Compatibility verification

Nexus supplies a reusable observable-seam check in `src/game-compatibility.js`. `verifyPublicGameCompatibility` verifies a successful HTTP response at the public player landing page and, when `capabilities.dedicatedDisplay` is `true`, `BASE_PATH/board/`. It follows at most five navigation redirects per route (301, 302, 303, 307, or 308), only on the same public origin under that game's base path and through routes accepted by Nexus's public path parser. Reserved management routes, ambiguous encoded paths, and URLs containing credentials are rejected before being fetched. Each request has a five-second deadline, configurable with `requestTimeoutMs`, and response bodies are canceled after headers are checked.

This check proves route availability and redirect containment only. It does not inspect page contents or establish asset delivery, browser transport/recovery, TV-less completeness, session behavior, or game authorization. It is an explicit adapter acceptance tool, not an automatic registry or runtime-readiness gate.

Use this check after launching an adapter through Nexus. Each game must also provide focused verification for game-owned behavior that Nexus cannot safely infer: server-authoritative state, join/create UX where applicable, reconnect recovery, TV-less completeness, and any room/board pairing semantics. The supervisor and readiness tests cover the shared launch, private binding, status, and shutdown seam.

## Clean shutdown and lifecycle

On the supported Linux runtime, a game must handle `SIGTERM` by stopping listeners and runtime-owned helpers and releasing its assigned private port promptly. Helpers must remain in Nexus's lifecycle boundary and preserve `NEXUS_LIFECYCLE_TOKEN` as described below. Nexus may force termination after its grace period; that fallback is not normal compatibility behavior.

## What Nexus does not standardize

Games remain free to choose their transport, exact lobby/room protocol, engine structure, state representation, frontend framework, package manager, persistence model, reconnect-token format, and dedicated-display contents or pairing flow.

If Nexus needs game-specific branches to understand those concepts, the integration boundary has become too wide.

## Process lifecycle

Nexus supervises one active game runtime initially. Starting another game stops the current runtime and releases its process/port resources before the replacement is launched.

On Linux, the local launcher starts a small Nexus-owned controller as the leader of a dedicated process group/session, then launches the manifest-declared root inside that anchored group. Normal runtime-owned helpers inherit the same group. Graceful and forced group signals are requested through that controller, so the destructive group-signal syscall originates from a process that is itself still in the owned group; a recycled numeric process-group ID therefore cannot redirect that signal to an unrelated generation. The controller deliberately survives `SIGTERM` while Nexus checks for remaining runtime members and exits only after graceful completion, or is terminated with the group by forced `SIGKILL`.

While the controller is alive, its presence keeps the numeric process-group ID allocated and Nexus may inspect the group directly. After the controller exits, Nexus uses the per-launch `NEXUS_LIFECYCLE_TOKEN` inherited by runtime-owned descendants to distinguish that launch generation from any unrelated process group that later reuses the same number. Completion is not reported, and the private-port lease is not released, while a live process from the owned generation remains. If the manifest root exits unexpectedly while descendants survive, the controller cleans the residual group before Nexus treats the runtime as terminated. If the controller itself disappears unexpectedly, Nexus does not send a later numeric group signal; ownership remains tied only to descendants that can still be associated with the launch generation.

Games should handle `SIGTERM` by closing their listener/helpers and releasing the assigned port promptly. Runtime-owned helpers must remain in the launcher-owned lifecycle boundary, preserve `NEXUS_LIFECYCLE_TOKEN`, and exit with that runtime. Nexus treats unexpected complete-runtime exit as a failed lifecycle state and releases the associated port lease only after termination is established.
