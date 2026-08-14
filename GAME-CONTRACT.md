# Tabletop Nexus game contract

This document defines the smallest interface a browser game must implement to be discoverable and, in later milestones, launchable by Tabletop Nexus.

The boundary is runtime integration, not game design: **Nexus knows how to run games; Nexus does not know how games work.**

## Contract version

Current schema: `1`.

Compatible games expose `boardgame.json` at the game repository root:

```json
{
  "schema": 1,
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
    "command": "npm",
    "args": ["run", "start:nexus"],
    "healthPath": "/healthz"
  }
}
```

## Required manifest fields

- `schema`: contract schema version. Currently `1`.
- `id`: stable lowercase identifier using letters, numbers, and single hyphens between segments.
- `name`: non-empty human-readable title.
- `players.min` / `players.max`: positive integers with `max >= min`.
- `capabilities.tvLess`: **must be `true`**.
- `runtime.command`: non-empty executable name or path that Nexus will launch directly, without a shell.
- `runtime.args`: array of argument strings passed directly to the executable.
- `runtime.healthPath`: local absolute HTTP path beginning with `/`; query strings, fragments, and protocol-relative paths are not allowed.

`description`, `personalDevices`, and `dedicatedDisplay` are optional descriptive metadata. Unknown fields are ignored by schema 1 so games may carry their own metadata without widening Nexus's responsibility.

## Public versus private metadata

The manifest is server-side runtime configuration. Nexus may expose these fields to browsers:

- `id`, `name`, `description`;
- `players`;
- `capabilities`;
- Nexus-owned lifecycle status.

Nexus must not expose configured filesystem roots, `runtime.command`, or `runtime.args` through its public API. Runtime details are execution authority, not library-card metadata.

## Runtime environment

When process supervision is implemented, Nexus will launch the declared command with the game repository as the working directory and provide:

- `HOST`: private bind host selected by Nexus;
- `PORT`: private port selected by Nexus;
- `BASE_PATH`: public route assigned to the game, for example `/games/example-game`.

A compatible game must not require a fixed port.

### Base-path behavior

A game must work when mounted below `BASE_PATH`, not only at `/`. Browser navigation, static assets, API calls, WebSockets/SSE, redirects, and cookie paths must remain within the assigned public base path.

Nexus may strip the public game prefix while proxying requests, but the browser-facing application must still generate URLs that remain under `BASE_PATH`.

## One-process LAN runtime

The launch command must produce one self-contained game runtime from Nexus's perspective: one process boundary and one private HTTP port. The process may use any internal architecture and is responsible for serving its frontend and browser-facing HTTP/WebSocket/SSE endpoints.

Development servers are not part of the runtime contract.

## Health check

`GET <runtime.healthPath>` must:

- return HTTP `200` when the game is ready to receive players;
- require no authentication or game state;
- be side-effect free;
- return promptly.

A JSON body such as `{ "ok": true }` is recommended but not required.

## TV-less requirement

Every compatible game must be completely playable **without a dedicated TV/display client**. A game may use a shared browser, individual player devices, a combined host/player view, or another layout that preserves the complete experience without a separate display.

A dedicated table display may still be supported and advertised with `capabilities.dedicatedDisplay`.

## What Nexus does not standardize

Games remain free to choose their own transport, lobby/room model, engine structure, game-state representation, frontend framework, package manager, persistence model, and dedicated-display behavior.

If Nexus needs game-specific branches to understand those concepts, the integration boundary has become too wide.

## Process lifecycle

Games must tolerate normal termination initiated by Nexus. Graceful shutdown on `SIGTERM` or the platform equivalent is strongly recommended. R1 will define startup timeout, health polling, and forced-shutdown behavior without widening this contract.
