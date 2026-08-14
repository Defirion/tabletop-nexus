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

Nexus owns the LAN-facing port. Games remain independent repositories/processes and, once R1/R2 land, bind to Nexus-selected private ports and are exposed under `/games/<game-id>/`.

## R0 components

### Registry

The registry reads local `nexus.config.json`, resolves configured game directories relative to that file, loads each `boardgame.json`, validates schema 1, rejects duplicate public game IDs, and produces browser-safe metadata.

Two boundaries are deliberate:

1. a missing Nexus config means an empty library, while malformed config or a configured game with a missing/invalid manifest is an error;
2. filesystem roots and runtime launch details never cross the browser API boundary.

### Portal server

The Node HTTP server exposes:

- `GET`/`HEAD /healthz` — Nexus health;
- `GET`/`HEAD /api/games` — configured, validated game metadata;
- an allowlisted static portal at `/`, `/app.js`, and `/styles.css`.

R0 does not start game processes or proxy game traffic. A configured game's lifecycle status is therefore `configured` rather than `running`.

## Planned runtime components

### Process supervisor (R1)

Responsible for allocating private ports, spawning manifest-declared commands directly (never through shell interpolation), supplying `HOST`/`PORT`/`BASE_PATH`, polling health, tracking lifecycle state, and stopping children with graceful and forced phases.

### Reverse proxy (R2)

Routes HTTP and upgrade/WebSocket traffic from `/games/<id>/...` to the correct private game process. It must remain transport-agnostic and must not inspect game payloads.

## Security model

The first target is a trusted home LAN, not hostile multi-tenant hosting. Even so:

- configuration and runtime commands are server-side only;
- public static paths are allowlisted rather than mapped directly to arbitrary filesystem paths;
- manifests are local trusted configuration, not remotely supplied launch instructions;
- future process spawning must use executable + argument arrays without shell interpolation;
- invalid or unregistered public game routes must be rejected;
- remote/internet exposure is out of scope until authentication and a stronger threat model exist.

## Design rule

**Nexus knows how to run games; Nexus does not know how games work.**

A new game integrates by satisfying `GAME-CONTRACT.md`, not by adding game-specific logic to Nexus.
