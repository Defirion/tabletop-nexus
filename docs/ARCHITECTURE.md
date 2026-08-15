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

Nexus owns the browser-facing port. Games remain independent repositories/processes and, once R1/R2 land, bind to Nexus-selected private ports and are exposed under `/games/<game-id>/`. The initial deployment policy keeps only one game runtime active at a time; multiple simultaneous runtimes remain a future capability.

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

### Process supervisor (R1, in progress)

Private port allocation is implemented as an OS-assisted loopback allocator. Nexus probes `127.0.0.1` with port `0`, closes that probe before returning the lease so the child process can bind the selected port, and keeps the port number logically claimed until the lease is released. This prevents Nexus from assigning one live allocation to multiple games. Because the probe must be closed before a separately launched game can bind, later process-start logic must still handle an external process winning that small probe-to-bind race.

The remaining supervisor responsibilities are spawning manifest-declared commands directly (never through shell interpolation), supplying `HOST`/`PORT`/`BASE_PATH`, polling Nexus readiness, tracking lifecycle state, enforcing the initial one-active-game policy, and stopping children with graceful and forced phases.

The launch boundary must also remain compatible with the stronger remote-play deployment boundary: a supported internet-facing deployment must be able to run the game under a security identity/sandbox distinct from Nexus so compromise of the game cannot open trusted player ingress or reach Nexus administration. Directly spawning a same-OS-identity child may remain useful for development/LAN operation, but it is not by itself sufficient isolation for supported remote play.

The current schema-1 contract still uses configurable `runtime.healthPath`. Before R1 readiness polling is implemented, the plan requires an atomic contract/schema, validator, and test migration to the fixed private `/__nexus/status` readiness surface rather than implementing the old seam and replacing it shortly afterward.

### Reverse proxy (R2)

Routes HTTP and upgrade/WebSocket traffic from `/games/<id>/...` to the correct private game process. It must remain transport-agnostic and must not inspect game payloads.

The private runtime-management namespace is a deliberate exception to prefix forwarding: after path canonicalization and `/games/<id>` removal, a target equal to `/__nexus` or beneath `/__nexus/` is never player-proxyable. Nexus uses that reserved namespace only across the private Nexus-to-game management seam, including `GET /__nexus/status`.

## Security model

The current implementation target is a trusted home LAN, not hostile multi-tenant hosting. Even so:

- configuration and runtime commands are server-side only;
- public static paths are allowlisted rather than mapped directly to arbitrary filesystem paths;
- manifests are local trusted configuration, not remotely supplied launch instructions;
- future process spawning must use executable + argument arrays without shell interpolation;
- invalid or unregistered public game routes must be rejected;
- the reserved private game-management namespace must never be forwarded from a player route.

Friends-only internet exposure is planned separately in [`REMOTE-PLAY.md`](REMOTE-PLAY.md). That design deliberately keeps players unauthenticated initially, adds a stronger public-ingress threat model and private admin boundary, and is not considered supported until its documented acceptance gate passes.

## Design rule

**Nexus knows how to run games; Nexus does not know how games work.**

A new game integrates by satisfying `GAME-CONTRACT.md`, not by adding game-specific logic to Nexus.
