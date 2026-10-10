# Docker deployment (homelab LAN profile)

Nexus runs as one container. Games are **not** in the image: they are git clones on the host, bind-mounted read-only at `/games`. Nexus re-reads its config and every `boardgame.json` on each library request, so adding or updating a game needs neither a rebuild nor a Nexus restart.

This is the LAN profile. Games run as child processes inside the Nexus container under the same user, which is the current trusted-LAN model. It is not a supported remote-play deployment; see [`../docs/REMOTE-PLAY.md`](../docs/REMOTE-PLAY.md).

## Host layout

```text
/srv/homestack/nexus/
├── config/                  mounted at /config (read-only)
│   └── nexus.config.json
└── games/                   mounted at /games (read-only)
    ├── pirate-shake/        git clone; node_modules installed by update-game.sh
    └── other-game/
```

`config/nexus.config.json` lists games by their path **inside the container**:

```json
{ "games": [ { "path": "/games/pirate-shake" } ] }
```

## One-time setup

On the Docker host, with `git` installed and a user in the `docker` group:

```bash
sudo mkdir -p /srv/homestack/nexus/games /srv/homestack/nexus/config
sudo chown "$USER": /srv/homestack/nexus /srv/homestack/nexus/games /srv/homestack/nexus/config

git clone <nexus-repo-url> ~/tabletop-nexus
cd ~/tabletop-nexus
cp deploy/nexus.config.example.json /srv/homestack/nexus/config/nexus.config.json
docker compose -f deploy/compose.yaml up -d --build
```

The portal is on host port `8400` (override with `NEXUS_PORT`). `NEXUS_HOME` overrides `/srv/homestack/nexus`.

The whole config directory is mounted so editors that save by atomic rename are visible on the next library refresh. `NEXUS_CONFIG` inside the container remains `/config/nexus.config.json`.

For an existing installation, move the old file into the new directory and recreate the container once with the updated Compose file (stop the active game first):

```bash
mkdir -p "${NEXUS_HOME:-/srv/homestack/nexus}/config"
mv "${NEXUS_HOME:-/srv/homestack/nexus}/nexus.config.json" "${NEXUS_HOME:-/srv/homestack/nexus}/config/nexus.config.json"
docker compose -f deploy/compose.yaml up -d
```

## Add a game

```bash
git clone <game-repo-url> /srv/homestack/nexus/games/pirate-shake
bash ~/tabletop-nexus/deploy/update-game.sh pirate-shake
```

Then add `{ "path": "/games/pirate-shake" }` to `config/nexus.config.json`. The game appears in the portal within a second.

Private repositories need read access from the host, for example a read-only deploy key per repository.

## Update a game

Push to GitHub from your PC, then on the host:

```bash
bash ~/tabletop-nexus/deploy/update-game.sh pirate-shake
```

The script:

1. fetches and resolves the remote's default branch (or `--ref <branch|tag|commit>`);
2. validates the target `boardgame.json` with Nexus's own parser **before** checking it out, because one invalid manifest fails the whole library;
3. refuses while that game is the active runtime, or while Nexus is mid-start/stop;
4. checks out the commit (detached; the server copy is deploy-only, local edits are discarded);
5. installs locked dependencies inside the Nexus image, so they match the runtime's Linux and Node. npm games require `package-lock.json`. pnpm games require `pnpm-lock.yaml` and an exact `packageManager: "pnpm@X.Y.Z"` in `package.json`; the installer downloads that version into its disposable `/tmp`. A game with a `build` script gets full dependencies, runs its build, then removes development dependencies (using a frozen production install for pnpm workspaces).

Games must launch from those prepared artifacts. The running container mounts `/games` read-only and has no build tools installed globally. Pirate Island prepares its web client and compiled server with `pnpm build`; Captain Flip uses `npm run build`. Both are handled by the same updater.

Roll back with `--ref <older-commit>`. Use `--reinstall` to reinstall dependencies without a new commit.

The running-game check happens before the install. Don't start that game in the portal while an update is in progress.

## Test on phones

Set `publicOrigin` in `config/nexus.config.json` to the Docker host's LAN URL, for example `http://192.168.10.210:8400`, so the portal's QR codes and share links work on phones. Open that URL on devices connected to the same LAN, then start a game from the portal. The phones use the Nexus port; no game port needs publishing.

With Docker Desktop, `NEXUS_HOME` can also be an absolute Windows directory containing `config/` and `games/`. Prepare dependencies inside Linux containers rather than copying Windows `node_modules`. The updater is a Bash host script; a local source snapshot can be prepared with its same installer, before launching Compose:

```powershell
$env:NEXUS_HOME = 'C:/path/to/nexus-home'
docker compose -f deploy/compose.yaml build
docker run --rm --user 1000:1000 -e HOME=/tmp -e npm_config_cache=/tmp/.npm -v "${env:NEXUS_HOME}/games/pirate-island:/work" -w /work tabletop-nexus:local node /app/deploy/install-game.mjs
docker compose -f deploy/compose.yaml up -d
```

Run the installer once per game folder, and list each `/games/<folder>` in the config. Stop the game before preparing another version. Source snapshots need refreshing explicitly; Git clones managed by `update-game.sh` support the normal update/rollback flow above.

If the portal works on the Windows host but other LAN devices cannot reach it, check Windows Firewall as well as the published port. On a trusted Private network, an elevated PowerShell can add a rule limited to the local subnet and the active Wi-Fi interface (replace the interface name with the one shown by `Get-NetConnectionProfile`):

```powershell
New-NetFirewallRule -Name 'TabletopNexus-LAN' -DisplayName 'Tabletop Nexus (private LAN)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8400 -Profile Private -RemoteAddress LocalSubnet -InterfaceAlias 'Wi-Fi 2'
```

Ping uses a separate ICMP rule; a failed ping alone does not establish that the portal port is blocked. The 10 October 2026 Docker Desktop mobile run passed after scoped TCP 8400 and ICMP echo rules were enabled on the host's Private Wi-Fi interface.

## Update Nexus itself

```bash
cd ~/tabletop-nexus && git pull
docker compose -f deploy/compose.yaml up -d --build
```

Stop the active game in the portal first. Recreating the container ends every process inside it, games included, and Nexus starts with no active game. `docker stop` sends `SIGTERM`, which Nexus handles by stopping the active game before exiting.

## Container settings

- `init: true` runs a small init as PID 1 so stray processes are reaped.
- `read_only: true` with a tmpfs at `/tmp`, and log rotation, per the homestack conventions.
- Nexus keeps a small restart-recovery record under `/tmp` (the tmpfs; override with `NEXUS_STATE_DIR`). It never needs to survive the container: a recreated container has no processes to recover. Because the root filesystem is read-only, a missing writable `/tmp` would make game starts fail rather than run untracked.
- Only the Nexus port is published. Game ports are private `127.0.0.1` ports inside the container.
- Nexus and the active game share the container's memory.

## Inspect game diagnostics

Nexus prints its host-local `runtime-diagnostics.json` path in `docker logs tabletop-nexus`. In the default profile, read it without exposing a new HTTP route:

```bash
docker exec tabletop-nexus cat /tmp/tabletop-nexus-1000/runtime-diagnostics.json
```

The file appears after the first game launch. It retains the latest four launches and bounded stdout/stderr tails, including failures and exits. It uses the `/tmp` tmpfs and is lost when the container stops or is recreated; copy needed excerpts before then. A custom `NEXUS_STATE_DIR` needs a private directory writable by the container's `node` user. Readiness/lifecycle tokens are removed, but games can print other private information, so keep diagnostics on the host and review excerpts before sharing.
