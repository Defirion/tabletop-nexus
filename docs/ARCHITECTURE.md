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
       |              |
       v              v
 private port A   private port B
 game process A  game process B
```

Nexus owns the LAN-facing port. Games bind to private ports selected by Nexus and are reachable publicly below `/games/<game-id>/`.

## Components

### Registry

Reads the local `nexus.config.json`, resolves configured game directories, loads each `boardgame.json`, validates the supported contract schema, and exposes only browser-safe metadata.

Local filesystem paths and runtime commands are server-side configuration and must not be returned by the public API.

### Portal server

Serves the Nexus UI and public API. The initial scaffold exposes `/healthz` and `/api/games` before process management is added.

### Process manager

Future runtime layer responsible for:

- allocating a private port;
- spawning a game's declared runtime command;
- supplying `HOST`, `PORT`, and `BASE_PATH`;
- polling the health endpoint until ready;
- tracking `stopped`, `starting`, `running`, and `failed` states;
- terminating child processes cleanly.

### Reverse proxy

Routes HTTP and upgrade/WebSocket traffic from `/games/<id>/...` to the correct private game process. It must remain transport-agnostic and must not inspect game payloads.

## Security model

The first target is a trusted home LAN, not hostile multi-tenant hosting. Even so:

- configuration is server-side only;
- game paths and launch commands are never exposed to browsers;
- manifests are treated as local trusted configuration, not remotely supplied code;
- Nexus must avoid shell interpolation when spawning commands;
- path traversal from public URLs must be rejected;
- games should bind to a Nexus-selected private interface where practical.

Remote/internet exposure is explicitly out of scope until authentication and a stronger threat model are designed.

## Design rule

**Nexus knows how to run games; Nexus does not know how games work.**

A new game should integrate by satisfying `GAME-CONTRACT.md`, not by adding branches to Nexus source code.
