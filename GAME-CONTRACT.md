# Tabletop Nexus game contract

This document defines the smallest interface a browser game must implement to be discoverable and launchable by Tabletop Nexus.

The boundary is runtime integration, not game design: **Nexus knows how to run games; Nexus does not know how games work.**

## Contract version

Current manifest schema: `2`.

Schema 2 replaces schema 1's configurable `runtime.healthPath` with the fixed private Nexus readiness surface `GET /__nexus/status`. Schema 1 is no longer accepted by the current validator; this is an explicit contract migration rather than a silent redefinition of schema 1.

Compatible games expose `boardgame.json` at the game repository root:

```json
{
  "schema": 2,
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

- `schema`: contract schema version. Currently `2`.
- `id`: stable lowercase identifier using letters, numbers, and single hyphens between segments.
- `name`: non-empty human-readable title.
- `players.min` / `players.max`: positive integers with `max >= min`.
- `capabilities.tvLess`: **must be `true`**.
- `runtime.command`: non-empty executable name or path that Nexus launches directly, without a shell.
- `runtime.args`: array of argument strings passed directly to the executable.

`runtime.command` must identify a program the target operating system can execute directly. It is not a command line: shell built-ins, pipelines, redirects, or strings such as `npm run start:nexus` do not belong in this field. Keep every argument in `runtime.args`. Platform command shims that themselves require a shell are not portable Nexus launch targets; use the underlying executable entrypoint instead.

`description`, `personalDevices`, and `dedicatedDisplay` are optional descriptive metadata. Unknown fields are ignored by schema 2 so games may carry their own metadata without widening Nexus's responsibility. A `runtime.healthPath` field has no Nexus meaning in schema 2; Nexus always polls the fixed readiness surface below.

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

A game must work when mounted below `BASE_PATH`, not only at `/`. Browser navigation, static assets, API calls, WebSockets/SSE, redirects, and cookie paths must remain within the assigned public base path.

Nexus may strip the public game prefix while proxying requests, but the browser-facing application must still generate URLs that remain under `BASE_PATH`.

## One-process LAN runtime

The launch command must produce one self-contained game runtime from Nexus's perspective: one Nexus-owned lifecycle boundary and one private browser-facing HTTP port. The root process may use helpers internally, but every runtime-owned descendant must remain inside the lifecycle boundary owned by the launcher and inherit the launcher-owned `NEXUS_LIFECYCLE_TOKEN` unchanged. A runtime must not daemonize, create a new session/process group, strip that lifecycle marker from a runtime-owned helper, or otherwise move helpers outside the boundary while they retain Nexus-assigned runtime state or resources.

The runtime is responsible for serving its frontend and browser-facing HTTP/WebSocket/SSE endpoints. Development servers are not part of the runtime contract.

## Nexus readiness surface

Every schema-2 runtime must expose this private endpoint on the assigned `HOST` and `PORT`:

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

## TV-less requirement

Every compatible game must be completely playable **without a dedicated TV/display client**. A game may use a shared browser, individual player devices, a combined host/player view, or another layout that preserves the complete experience without a separate display.

A dedicated table display may still be supported and advertised with `capabilities.dedicatedDisplay`.

## What Nexus does not standardize

Games remain free to choose their own transport, lobby/room model, engine structure, game-state representation, frontend framework, package manager, persistence model, and dedicated-display behavior.

If Nexus needs game-specific branches to understand those concepts, the integration boundary has become too wide.

## Process lifecycle

Nexus supervises one active game runtime initially. Starting another game stops the current runtime and releases its process/port resources before the replacement is launched.

On Linux, the local launcher starts a small Nexus-owned controller as the leader of a dedicated process group/session, then launches the manifest-declared root inside that anchored group. Normal runtime-owned helpers inherit the same group. Graceful and forced group signals are requested through that controller, so the destructive group-signal syscall originates from a process that is itself still in the owned group; a recycled numeric process-group ID therefore cannot redirect that signal to an unrelated generation. The controller deliberately survives `SIGTERM` while Nexus checks for remaining runtime members and exits only after graceful completion, or is terminated with the group by forced `SIGKILL`.

While the controller is alive, its presence keeps the numeric process-group ID allocated and Nexus may inspect the group directly. After the controller exits, Nexus uses the per-launch `NEXUS_LIFECYCLE_TOKEN` inherited by runtime-owned descendants to distinguish that launch generation from any unrelated process group that later reuses the same number. Completion is not reported, and the private-port lease is not released, while a live process from the owned generation remains. If the manifest root exits unexpectedly while descendants survive, the controller cleans the residual group before Nexus treats the runtime as terminated. If the controller itself disappears unexpectedly, Nexus does not send a later numeric group signal; ownership remains tied only to descendants that can still be associated with the launch generation.

Games should handle `SIGTERM` by closing their listener/helpers and releasing the assigned port promptly. Runtime-owned helpers must remain in the launcher-owned lifecycle boundary, preserve `NEXUS_LIFECYCLE_TOKEN`, and exit with that runtime. Nexus treats unexpected complete-runtime exit as a failed lifecycle state and releases the associated port lease only after termination is established.
