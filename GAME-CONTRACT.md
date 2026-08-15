# Tabletop Nexus game contract

This document defines the smallest interface a browser game must implement to be discoverable and launchable by Tabletop Nexus.

The boundary is runtime integration, not game design: **Nexus knows how to run games; Nexus does not know how games work.**

## Contract version

Current schema: `2`.

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

Nexus must not expose configured filesystem roots, `runtime.command`, or `runtime.args` through its public API. Runtime details are execution authority, not library-card metadata.

## Runtime environment and private bind

Nexus launches the declared command with the game repository as the working directory and supplies:

- `HOST`: Nexus-selected private bind host;
- `PORT`: Nexus-selected private port;
- `BASE_PATH`: canonical public route assigned to the game, `/games/<game-id>`, without a trailing slash.

The runtime must bind its browser-facing listener to the exact supplied `HOST` and `PORT`. It must not widen the bind to `0.0.0.0`, `::`, or another interface in Nexus mode. If the assigned bind cannot be satisfied, startup must fail rather than choosing another address or fixed port.

### Base-path behavior

A game must work when mounted below `BASE_PATH`, not only at `/`. Browser navigation, static assets, API calls, WebSockets/SSE, redirects, and cookie paths must remain within the assigned public base path.

Nexus may strip the public game prefix while proxying requests, but the browser-facing application must still generate URLs that remain under `BASE_PATH`.

## One-process LAN runtime

The launch command must produce one self-contained game runtime from Nexus's perspective: one process boundary and one private browser-facing HTTP port. The process may use any internal architecture and is responsible for serving its frontend and browser-facing HTTP/WebSocket/SSE endpoints.

Development servers are not part of the runtime contract.

## Nexus readiness surface

Every schema-2 runtime must expose this private endpoint on the assigned `HOST` and `PORT`:

```http
GET /__nexus/status
```

A well-formed response returns HTTP `200`, `Content-Type: application/json`, and a JSON object using status-payload schema 1:

```json
{
  "schema": 1,
  "ready": true
}
```

`ready` has one platform meaning: **Nexus may route players to this runtime.**

Requirements:

- `schema` is the integer status-payload schema version and is currently `1`;
- `ready` is a required boolean;
- `ready: false` is a valid response meaning the runtime is alive but not yet player-ready;
- unknown fields are ignored when the status schema is supported;
- the endpoint requires no authentication or game state, is side-effect free, and returns promptly.

Timeouts, connection failures, non-`200` responses, non-JSON content, malformed JSON, unsupported status schemas, or missing/invalid required fields are treated as not ready. Nexus never consults a manifest-configured readiness path.

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

On Linux, Nexus first requests graceful termination with `SIGTERM`, waits for its configured grace period, and uses `SIGKILL` as the forced fallback if the runtime does not exit. Games should handle `SIGTERM` by closing their listener/helpers and releasing the assigned port promptly. Nexus treats unexpected process exit as a failed lifecycle state and releases the associated port lease after the process is known to have exited.
