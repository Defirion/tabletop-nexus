# Docker deployment (homelab LAN profile)

Nexus runs as one container. Games are **not** in the image: they are git clones on the host, bind-mounted read-only at `/games`. Nexus re-reads its config and every `boardgame.json` on each library request, so adding or updating a game needs neither a rebuild nor a Nexus restart.

This is the LAN profile. Games run as child processes inside the Nexus container under the same user, which is the current trusted-LAN model. It is not a supported remote-play deployment; see [`../docs/REMOTE-PLAY.md`](../docs/REMOTE-PLAY.md).

## Host layout

```text
/srv/homestack/nexus/
├── nexus.config.json        mounted at /config/nexus.config.json (read-only)
└── games/                   mounted at /games (read-only)
    ├── pirate-shake/        git clone; node_modules installed by update-game.sh
    └── other-game/
```

`nexus.config.json` lists games by their path **inside the container**:

```json
{ "games": [ { "path": "/games/pirate-shake" } ] }
```

## One-time setup

On the Docker host, with `git` installed and a user in the `docker` group:

```bash
sudo mkdir -p /srv/homestack/nexus/games
sudo chown "$USER": /srv/homestack/nexus /srv/homestack/nexus/games
echo '{ "games": [] }' > /srv/homestack/nexus/nexus.config.json

git clone <nexus-repo-url> ~/tabletop-nexus
cd ~/tabletop-nexus
docker compose -f deploy/compose.yaml up -d --build
```

The portal is on host port `8400` (override with `NEXUS_PORT`). `NEXUS_HOME` overrides `/srv/homestack/nexus`.

## Add a game

```bash
git clone <game-repo-url> /srv/homestack/nexus/games/pirate-shake
bash ~/tabletop-nexus/deploy/update-game.sh pirate-shake
```

Then add `{ "path": "/games/pirate-shake" }` to `nexus.config.json`. The game appears in the portal within a second.

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
5. runs `npm ci` inside the Nexus image, so dependencies match the runtime's Linux and Node. A game with a `build` script gets full dependencies, `npm run build`, then dev dependencies are pruned. A `package-lock.json` is required.

Roll back with `--ref <older-commit>`. Use `--reinstall` to reinstall dependencies without a new commit.

The running-game check happens before the install. Don't start that game in the portal while an update is in progress.

## Update Nexus itself

```bash
cd ~/tabletop-nexus && git pull
docker compose -f deploy/compose.yaml up -d --build
```

Stop the active game in the portal first. Recreating the container ends every process inside it, games included, and Nexus starts with no active game.

## Container settings

- `init: true` runs a small init as PID 1 so stray processes are reaped.
- `read_only: true` with a tmpfs at `/tmp`, and log rotation, per the homestack conventions.
- Only the Nexus port is published. Game ports are private `127.0.0.1` ports inside the container.
- Nexus and the active game share the container's memory.
