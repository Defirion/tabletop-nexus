# Tabletop Nexus

Tabletop Nexus is a self-hosted portal and runtime orchestrator for browser-based tabletop games. The current implementation targets LAN play first; the repository also records a planned friends-only remote-play architecture.

The project has one deliberately narrow responsibility:

> **Nexus knows how to run games; Nexus does not know how games work.**

Games remain independent applications and repositories. Tabletop Nexus discovers compatible games through a small manifest contract, supervises one active private game runtime, and securely proxies that runtime's HTTP, WebSocket, and SSE traffic behind the single browser-facing Nexus port.

## Goals

- One friendly portal for a local library of browser-based tabletop games.
- One browser-facing Nexus port regardless of how many games are installed.
- A small, versioned integration contract instead of game-specific coupling.
- Independent game engines, protocols, UI stacks, and repositories.
- Mandatory **TV-less play** for compatible games.
- No copyrighted game rules, artwork, assets, or data in this repository.

## Status

**R2 single-port routing implemented.** The current schema-2 game contract, local library discovery/validation, browser-safe `/api/games` output, minimal portal, private-port allocation, shell-free launch boundary, fixed readiness polling, lifecycle state, graceful/forced stop, one-active-game sequencing, and registered-game HTTP/WebSocket/SSE proxying are implemented. Public game routing strips `BASE_PATH` while reserving every canonical ASCII case form of the private `__nexus` first path segment.

See [`docs/PLAN.md`](docs/PLAN.md) for roadmap status and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for current component boundaries.

Planning documents for later architecture are also available:

- [`docs/GAME-AUTHORING-GUIDE.md`](docs/GAME-AUTHORING-GUIDE.md) — selected stricter game-integration direction for later contract promotion;
- [`docs/DEPLOYMENT-MODEL.md`](docs/DEPLOYMENT-MODEL.md) — ordinary-Linux-host and one-active-game deployment assumptions;
- [`docs/REMOTE-PLAY.md`](docs/REMOTE-PLAY.md) — proposed friends-only internet exposure, security model, and support gate.

[`GAME-CONTRACT.md`](GAME-CONTRACT.md) remains the current normative compatibility contract.

## Architecture

```text
LAN clients
    |
    v
Tabletop Nexus :3000
    |-- /                     portal
    |-- /api/games            configured game metadata
    |-- /games/<game-id>/...  HTTP/WebSocket/SSE reverse proxy
    |
    +-- R1 supervisor -> one selected private game runtime
```

Compatible games use the integration boundary in [`GAME-CONTRACT.md`](GAME-CONTRACT.md).

## Local development

Requires Node.js 22 or newer. The project currently has no package dependencies.

```bash
cp nexus.config.example.json nexus.config.json
npm start
```

On Windows PowerShell:

```powershell
Copy-Item nexus.config.example.json nexus.config.json
npm start
```

The default Nexus address is `http://localhost:3000`. `HOST`, `PORT`, and `NEXUS_CONFIG` can override the local server settings. A missing `nexus.config.json` is valid and produces an empty library.

## Adding a game locally

A compatible schema-2 game keeps `boardgame.json` at its repository root. Add that repository path to local `nexus.config.json`:

```json
{
  "games": [
    { "path": "../my-browser-game" }
  ]
}
```

Relative game paths are resolved from the config file's directory. The local config is gitignored. Game repositories and their content are not vendored into Nexus.

## Verification

Run the repository's syntax checks and test suite:

```bash
npm run verify
```

There are no package dependencies to install at this stage. Repository development guidance and the security invariants that changes must preserve are summarized in [`AGENTS.md`](AGENTS.md); the product architecture documents remain authoritative.

## Licensing

A project license has not been selected yet. Until one is added, normal copyright applies to this repository's source code.
