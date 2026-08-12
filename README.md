# Tabletop Nexus

Tabletop Nexus is a self-hosted LAN portal and runtime orchestrator for browser-based tabletop games.

The project has one deliberately narrow responsibility:

> **Nexus knows how to run games; Nexus does not know how games work.**

Games remain independent applications and repositories. Tabletop Nexus will discover compatible games, launch and stop their local servers, check their health, and expose them behind one LAN-facing portal and port.

## Goals

- One friendly portal for a local library of browser-based tabletop games.
- One public LAN port regardless of how many games are installed.
- A small, versioned integration contract instead of game-specific coupling.
- Independent game engines, protocols, UI stacks, and repositories.
- Mandatory **TV-less play** for compatible games.
- No copyrighted game rules, artwork, assets, or data in this repository.

## Status

**Workflow bootstrap.** The AI/GitHub development workflow is being established before application scaffolding begins. Product architecture, the game compatibility contract, runtime code, and adapters come after this baseline is reviewed and merged.

## AI-assisted development workflow

GitHub is the shared state between independent Implementer, Verifier, and Reviewer runs:

```text
Task -> Implement -> PR -> Verify -> Review -> Merge
                         ^         |
                         +-- Fix <-+
```

Start with `AGENTS.md`. `VERIFICATION.md` defines the canonical local evidence contract; role-specific instructions live under `docs/ai/`.

## Planned shape

```text
LAN clients
    |
    v
Tabletop Nexus
    |-- portal
    |-- game registry/runtime status
    |-- /games/<game-id>/... reverse proxy
    |
    +-- private game process A
    +-- private game process B
```

This is architectural intent only; application scaffolding has not started yet.

## Licensing

A project license has not been selected yet.
