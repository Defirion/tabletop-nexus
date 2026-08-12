# Tabletop Nexus

Tabletop Nexus is a self-hosted LAN portal and runtime orchestrator for browser-based tabletop games.

The project has one deliberately narrow responsibility:

> **Nexus knows how to run games; Nexus does not know how games work.**

Games remain independent applications and repositories. Tabletop Nexus discovers compatible games, launches and stops their local servers, checks their health, and exposes them behind one LAN-facing portal and port.

## Goals

- One friendly portal for a local library of browser-based tabletop games.
- One public LAN port regardless of how many games are installed.
- A small, versioned integration contract instead of game-specific coupling.
- Independent game engines, protocols, UI stacks, and repositories.
- Mandatory **TV-less play** for compatible games.
- No copyrighted game rules, artwork, assets, or data in this repository.

## Status

Early scaffolding. The runtime contract and initial portal architecture are being established before game adapters are added.

## Planned shape

```text
LAN clients
    |
    v
Tabletop Nexus :3000
    |-- /                     portal
    |-- /api/games            library/runtime status
    |-- /games/<game-id>/...  reverse proxy
    |
    +-- private game process A
    +-- private game process B
```

See `GAME-CONTRACT.md` for the integration boundary and `docs/ARCHITECTURE.md` / `docs/PLAN.md` as the implementation takes shape.

## Licensing

A project license has not been selected yet.
