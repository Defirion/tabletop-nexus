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

The N0 schema-3 baseline and the first N2 portal slice are merged into `main`; [`docs/PLAN.md`](docs/PLAN.md) records their verification status. Real-game adapter acceptance remains N1 work. The first N2 portal slice now provides fixture-verified start/stop/switch controls, live lifecycle state, friendly failure summaries, ready game/advertised-board links, and in-browser QR codes for those links. Restart recovery (a restarted Nexus verifies and reports what a crashed one left behind, on Linux) is implemented; optional profile/diagnostic/metadata work remains open. The Windows verification gate skips the Linux-only lifecycle and restart checks; the full suite, including them, passes in a Linux Node 22 container. Real-game Linux acceptance remains part of N1/N3.

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

The default Nexus address is `http://localhost:3000`. `HOST`, `PORT`, and `NEXUS_CONFIG` can override the local server settings; `NEXUS_STATE_DIR` moves the restart-recovery record (see "Restarting Nexus"). A missing `nexus.config.json` is valid and produces an empty library.

For the homelab Docker deployment, with games bind-mounted from the host and updated without rebuilding the image, see [`deploy/README.md`](deploy/README.md).

## Operating the LAN portal

Choose **Start game**, then wait for **Running** and select **Open game**. A ready game advertising a dedicated display also offers **Open board display** at its canonical board route. The score pad beside the running game shows a QR code for each link: players scan it, and pressing it copies the link to share another way.

Set the optional `publicOrigin` in local `nexus.config.json` to the Nexus address players can reach. Open links, QR codes, and copied links will use it even when you open the portal through localhost or an internal address:

```json
{
  "publicOrigin": "http://192.168.1.20:3000",
  "games": [{ "path": "../my-browser-game" }]
}
```

Replace the example with the host's LAN address and **Nexus port**, not the game's private port. The value must be an HTTP(S) origin without credentials, a path, query, or fragment; loopback and wildcard addresses are rejected. Nexus validates its format but cannot establish that another device can reach it. Keep it current if the host address changes. Without this setting, links use the address you opened; the portal warns when QR codes use a loopback address. The setting does not change listeners, proxy routing, or host-control requests, and does not enable remote-play support.

Use **Stop game** or **Switch to this game** to change runtimes. The portal asks you to confirm because the active game's current session ends for all players. Game-specific room, host and seat controls remain inside each game. Status refreshes automatically; **Refresh library** retries a failed load or picks up local configuration changes. If cleanup fails, retry Stop and check the Nexus host console before restarting anything.

A failed startup shows **Didn’t start**. A running game that exits shows **Game stopped unexpectedly** and can be started again for a new session. Unresolved cleanup shows **Cleanup needs attention** and keeps starts paused. Success feedback clears when refreshed state no longer supports it.

The portal is for a trusted LAN: anyone with access can operate its host controls. Remote play and separate private administration remain future work.

### Restarting Nexus

**Restarting Nexus ends the running game for everyone in it; rooms are not saved or resumed.** Stop with **Stop game** first if players are mid-session.

- Ctrl+C / `SIGTERM` (for example `docker stop`, `systemctl stop`) stops the active game cleanly, then exits.
- If Nexus crashes or is killed, on Linux the game's own supervisor process shuts the game down within a few seconds. The restarted portal shows the old game as **Stopping** until that finishes, then an empty table. Nexus verifies this against a small ownership record and never signals a process it cannot prove it launched.
- If a leftover game cannot be confirmed stopped (for example someone killed only part of it), the portal shows it as **Failed**, keeps **Start** paused, and the Nexus console says what to stop. It clears by itself once those processes are gone. If it reports a damaged ownership record, check for a leftover game process, then delete `runtime-ownership.json` from the state directory.
- The record lives in `NEXUS_STATE_DIR` (default: a per-user folder under the system temp directory). Recovery is Linux-only. On Windows and macOS, stop the game before killing Nexus: a game that survives a Nexus crash there is not detected.

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
