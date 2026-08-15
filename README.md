# Tabletop Nexus

Tabletop Nexus is a self-hosted portal and runtime orchestrator for browser-based tabletop games. The current implementation targets LAN play first; the repository also records a planned friends-only remote-play architecture.

The project has one deliberately narrow responsibility:

> **Nexus knows how to run games; Nexus does not know how games work.**

Games remain independent applications and repositories. Tabletop Nexus discovers compatible games through a small manifest contract; later milestones launch, readiness-check, stop, and proxy those runtimes behind one browser-facing portal and port.

## Goals

- One friendly portal for a local library of browser-based tabletop games.
- One browser-facing Nexus port regardless of how many games are installed.
- A small, versioned integration contract instead of game-specific coupling.
- Independent game engines, protocols, UI stacks, and repositories.
- Mandatory **TV-less play** for compatible games.
- No copyrighted game rules, artwork, assets, or data in this repository.

## Status

**R0 platform baseline.** The schema-1 game contract, local library discovery/validation, browser-safe `/api/games` output, and a minimal portal are implemented. Process supervision (R1) and single-port game routing (R2) are deliberately not part of this baseline.

See [`docs/PLAN.md`](docs/PLAN.md) for roadmap status and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for current component boundaries.

Planning documents for the intended next-stage architecture are also available:

- [`docs/GAME-AUTHORING-GUIDE.md`](docs/GAME-AUTHORING-GUIDE.md) — selected stricter game-integration direction for the next contract revision;
- [`docs/DEPLOYMENT-MODEL.md`](docs/DEPLOYMENT-MODEL.md) — ordinary-Linux-host and one-active-game deployment assumptions;
- [`docs/REMOTE-PLAY.md`](docs/REMOTE-PLAY.md) — proposed friends-only internet exposure, security model, and support gate.

Those planning documents do not claim their future requirements are already implemented; [`GAME-CONTRACT.md`](GAME-CONTRACT.md) remains the current normative compatibility contract.

## Architecture

```text
LAN clients
    |
    v
Tabletop Nexus :3000
    |-- /                     portal
    |-- /api/games            configured game metadata
    |-- /games/<game-id>/...  reverse proxy (planned R2)
    |
    +-- private game process A (planned R1)
    +-- private game process B (planned R1)
```

Compatible games use the integration boundary in [`GAME-CONTRACT.md`](GAME-CONTRACT.md).

## Local development

Requires Node.js 22 or newer. R0 has no package dependencies.

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

A compatible game keeps `boardgame.json` at its repository root. Add that repository path to local `nexus.config.json`:

```json
{
  "games": [
    { "path": "../my-browser-game" }
  ]
}
```

Relative game paths are resolved from the config file's directory. The local config is gitignored. Game repositories and their content are not vendored into Nexus.

## Verification

Focused product checks:

```bash
npm run verify:local
```

Canonical repository verification remains:

```powershell
pwsh -NoProfile -File .\verify.ps1
```

The canonical verifier runs the product checks in addition to the Agent-Workflow scaffold checks. See [`VERIFICATION.md`](VERIFICATION.md).

## AI-assisted development workflow

GitHub is the shared state between independent Implementer, Verifier, and Reviewer runs. Start with [`AGENTS.md`](AGENTS.md).

## Licensing

A project license has not been selected yet. Until one is added, normal copyright applies to this repository's source code.
