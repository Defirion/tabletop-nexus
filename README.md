# Tabletop Nexus

Tabletop Nexus is a self-hosted LAN portal and runtime orchestrator for browser-based tabletop games.

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

Early scaffolding. The schema-1 game contract, local library discovery, and a minimal portal/API baseline are in place. Process supervision and reverse proxying are the next runtime milestones.

## Architecture

```text
LAN clients
    |
    v
Tabletop Nexus :3000
    |-- /                     portal
    |-- /api/games            library/runtime status
    |-- /games/<game-id>/...  reverse proxy (planned R2)
    |
    +-- private game process A
    +-- private game process B
```

See [`GAME-CONTRACT.md`](GAME-CONTRACT.md) for the compatibility boundary, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for platform responsibilities, and [`docs/PLAN.md`](docs/PLAN.md) for the roadmap.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
cp nexus.config.example.json nexus.config.json
npm run dev
```

On Windows PowerShell, use:

```powershell
Copy-Item nexus.config.example.json nexus.config.json
npm run dev
```

The default Nexus address is `http://localhost:3000`. `HOST`, `PORT`, and `NEXUS_CONFIG` can override the local server settings.

A missing `nexus.config.json` is valid and produces an empty library.

## Adding a game locally

A compatible game keeps a `boardgame.json` at its own repository root. Add that repository path to your local `nexus.config.json`:

```json
{
  "games": [
    { "path": "../my-browser-game" }
  ]
}
```

The local configuration is gitignored. Game repositories and their content are not vendored into Nexus.

## Verification

```bash
npm run verify:local
```

See [`VERIFICATION-CONTRACT.md`](VERIFICATION-CONTRACT.md) for the development gate.

## Licensing

A project license has not been selected yet. Until one is added, normal copyright applies to this repository's source code.
