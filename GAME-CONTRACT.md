# Tabletop Nexus game contract

This document defines the smallest interface a browser game must implement to be launchable by Tabletop Nexus.

The contract is intentionally about **runtime integration**, not game design. Nexus must never need to understand a game's rules, room model, transport protocol, or UI framework.

## Contract version

Current schema: `1`.

Compatible games expose a `boardgame.json` file at the game repository root.

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
- `id`: stable lowercase identifier using letters, numbers, and hyphens.
- `name`: human-readable title.
- `players.min` / `players.max`: supported player range.
- `capabilities.tvLess`: **must be `true`**.
- `runtime.command`: executable Nexus launches without a shell.
- `runtime.args`: argument array passed to the executable.
- `runtime.healthPath`: HTTP health endpoint, normally `/healthz`.

`description`, `personalDevices`, and `dedicatedDisplay` are descriptive metadata and do not alter game behavior.

## Runtime environment

Nexus launches the declared command with the game repository as the working directory and provides:

- `HOST`: private bind host selected by Nexus.
- `PORT`: private port selected by Nexus.
- `BASE_PATH`: public route assigned to the game, e.g. `/games/example-game`.

A compatible game must not require a fixed port.

### Base-path behavior

A game must work when mounted below `BASE_PATH`, not only at `/`.

That means browser navigation, static assets, API calls, WebSockets/SSE, redirects, and cookie paths must remain within the assigned base path. Relative URLs are encouraged where practical.

Nexus may strip the public game prefix while proxying requests, but the browser-facing application must still generate URLs that remain under `BASE_PATH`.

## One-process LAN runtime

The launch command must produce one self-contained game runtime. It may use any internal architecture, but from Nexus's perspective there is one process boundary and one private HTTP port.

That process is responsible for serving whatever the game needs: frontend assets and HTTP/WebSocket/SSE endpoints.

Development servers are not part of the runtime contract.

## Health check

`GET <runtime.healthPath>` must:

- return HTTP `200` when the game is ready to receive players;
- complete without requiring authentication or game state;
- be side-effect free;
- return promptly.

A JSON body such as `{ "ok": true }` is recommended but not required.

## TV-less requirement

Every compatible game must be completely playable **without a dedicated TV/display client**.

This does not require every game to use hot-seat play. Depending on the game, valid approaches include:

- one shared browser/device;
- individual player devices with one of them also providing shared-table information;
- a combined host/player view;
- any other layout that preserves the complete playable experience without a separate display.

A dedicated TV/table display may still be supported and advertised with `capabilities.dedicatedDisplay`.

## What Nexus does not standardize

Games are free to choose:

- REST, WebSockets, SSE, polling, or another browser-compatible transport;
- lobby and room models;
- authoritative-server or client-heavy architectures;
- engine structure and game-state representation;
- frontend framework;
- package manager and build system;
- persistence model;
- dedicated-display behavior.

If Nexus needs game-specific code to understand any of those things, the contract boundary has become too wide.

## Process lifecycle

Games must tolerate normal termination initiated by Nexus. Graceful shutdown on `SIGTERM`/platform-equivalent signals is strongly recommended so active state can be persisted if the game supports persistence.

The first runtime implementation will define exact startup timeout and shutdown escalation behavior without widening the game contract.
