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

**R2 single-port routing and the schema-3 adapter contract are implemented.** The current contract, local library discovery/validation, browser-safe `/api/games` output, minimal portal, private-port allocation, shell-free launch boundary, fixed readiness polling, lifecycle state, graceful/forced stop, one-active-game sequencing, and registered-game HTTP/WebSocket/SSE proxying are implemented. Public game routing strips `BASE_PATH` while reserving every canonical ASCII case form of the private `__nexus` first path segment.

The N0 schema-3 baseline is finalized locally; [`docs/PLAN.md`](docs/PLAN.md) records its branch and verification status. Publication/integration into upstream `main` is separate. Real-game adapter acceptance remains N1 work. The first N2 portal slice now provides fixture-verified start/stop/switch controls, live lifecycle state, friendly failure summaries, ready game/advertised-board links, and in-browser QR codes for those links. Restart reconciliation and optional profile/diagnostic/metadata work remain open. The Windows verification gate skips six Linux-only lifecycle checks; Linux acceptance remains part of N1/N3.

See [`docs/PLAN.md`](docs/PLAN.md) for roadmap status and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for current component boundaries.

Planning documents for later architecture are also available:

- [`docs/GAME-AUTHORING-GUIDE.md`](docs/GAME-AUTHORING-GUIDE.md) — rationale and guidance for the schema-3 game-integration contract;
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
    |-- /api/games            game metadata, state and ready links
    |-- /api/games/<id>/start POST start/switch
    |-- /api/games/<id>/stop   POST stop the expected active game
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

## Operating the LAN portal

Choose **Start game**, then wait for **Running** and select **Open game**. A ready game advertising a dedicated display also offers **Open board display** at its canonical board route. Both links use the Nexus address you opened; open the portal using its LAN address when sharing links with another device.

Use **Stop game** or **Switch to this game** to change runtimes. The portal asks you to confirm because the active game's current session ends for all players. Game-specific room, host and seat controls remain inside each game. Status refreshes automatically; **Refresh library** retries a failed load or picks up local configuration changes. If cleanup fails, retry Stop and check the Nexus host console before restarting anything.

The portal is for a trusted LAN: anyone with access can operate its host controls. Remote play and separate private administration remain future work. Stop the active game before shutting down Nexus. This slice does not recover a surviving game after a Nexus crash/restart or promise saved rooms.

## Adding a game locally

A compatible schema-3 game keeps `boardgame.json` at its repository root. Add that repository path to local `nexus.config.json`:

```json
{
  "games": [
    { "path": "../my-browser-game" }
  ]
}
```

Relative game paths are resolved from the config file's directory. The local config is gitignored. Game repositories and their content are not vendored into Nexus.

Only manifest schema 3 is accepted. Schema-2 games, including the existing Pirate Island adapter, need a behavior-and-manifest migration before registration here. Invalid configured manifests fail the library load; temporarily remove an older registration while migrating it. Nexus never upgrades a game's capability claims automatically. The private readiness payload remains schema 2. See [`GAME-CONTRACT.md`](GAME-CONTRACT.md) for the migration requirements.

## Verification

Run the repository's syntax checks and test suite:

```bash
npm run verify
```

There are no package dependencies to install at this stage. Repository development guidance and the security invariants that changes must preserve are summarized in [`AGENTS.md`](AGENTS.md); the product architecture documents remain authoritative.

## Licensing

A project license has not been selected yet. Until one is added, normal copyright applies to this repository's source code.
