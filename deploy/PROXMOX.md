# Always-on Nexus on a Debian VM

This is the next deployment step: move the working LAN portal from the PC to
Docker Engine on our Proxmox Debian VM. The successful Pirate Island and Captain
Flip play-throughs are the gameplay baseline. No additional device inventory is
required for this move.

The portal stays available while the PC is off. A host still starts the chosen
game from the portal; only one game runs at a time. VM/container restarts end
live games and return to an idle library. They do not restore rooms or seats.

This guide prepares a trusted-LAN deployment. Internet access remains the
separate [remote-play milestone](../docs/REMOTE-PLAY.md).

## Prepare the VM

Use an existing Debian Docker VM if it has enough headroom. For a new guest,
Debian 13 amd64 with 2 vCPUs, 4 GiB RAM and a 40 GiB disk is a starting allocation,
including game builds and retained images; it is not a measured minimum. Check
`docker stats --no-stream tabletop-nexus` and `df -h` after installation and play
before reducing it. The image keeps its Node 22/Bookworm userspace independently
of the Debian guest version.

In Proxmox, give the VM a VirtIO network adapter on the trusted LAN bridge, enable
**Start at boot**, and enable the **QEMU Guest Agent** option. Install the agent
inside Debian. Proxmox documents these controls in its
[VM guide](https://github.com/proxmox/pve-docs/blob/master/qm.adoc).

Reserve a stable LAN IPv4 address in DHCP, or configure a static address. The
examples use `192.168.10.210`; replace it everywhere with the VM's address.
Keep TCP 8400 reachable from the intended LAN devices. If the VM has other
network interfaces, the explicit Compose bind below avoids publishing Nexus on
all of them. Bind-address selection does not replace subnet filtering: configure
the Proxmox VM firewall/router for the intended LAN. Docker-published ports can
bypass UFW rules; see [Docker's firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

## Install Docker Engine

Run these commands inside Debian as the administrator. Skip the Docker repository
setup if this VM already has Docker Engine and the Compose plugin installed.
Use the [official Debian installation instructions](https://docs.docker.com/engine/install/debian/)
if existing Docker/containerd packages conflict.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git qemu-guest-agent
sudo systemctl start qemu-guest-agent

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in for Docker group membership, then run `docker info` and
`docker compose version`. Docker group access gives host administration power;
use the VM administrator account. Host Node/npm/pnpm installations are unnecessary.

## Prepare the host folders and image

The source checkout builds Nexus. Host game clones hold each game's own source,
assets and Linux-prepared dependencies. Games remain outside the Nexus image,
so an adapter update does not require rebuilding Nexus.

```text
/srv/homestack/nexus/
├── compose.env                  local Compose settings
├── config/nexus.config.json     library and player-facing LAN origin
├── games/pirate-island/          game clone and prepared artifacts
├── games/captain-flip/           game clone and prepared artifacts
└── .update-game/                 successful installation commit markers
~/tabletop-nexus/                 Nexus source and deployment commands
```

Create the installation as the administrator account that will own the clones:

```bash
sudo install -d -o "$(id -u)" -g "$(id -g)" /srv/homestack/nexus
mkdir -p /srv/homestack/nexus/config /srv/homestack/nexus/games
umask 022
git clone https://github.com/Defirion/tabletop-nexus.git ~/tabletop-nexus
cd ~/tabletop-nexus
# Check out the chosen revision containing this deployment preparation.
cp deploy/vm.env.example /srv/homestack/nexus/compose.env
cp deploy/nexus.config.example.json /srv/homestack/nexus/config/nexus.config.json
```

Edit `/srv/homestack/nexus/compose.env`: set `NEXUS_BIND_IP` to the reserved VM
address, and choose a unique image tag, such as `tabletop-nexus:vm-initial`.
Keep a release tag tied to one build rather than rebuilding over it.

Load these settings in the shell so both Compose and the game updater use the
same home/image. Repeat this block when opening a new SSH session:

```bash
export NEXUS_HOME=/srv/homestack/nexus
set -a
. "$NEXUS_HOME/compose.env"
set +a
NEXUS_REPO="$HOME/tabletop-nexus"
dc() {
  docker compose --env-file "$NEXUS_HOME/compose.env" -f "$NEXUS_REPO/deploy/compose.yaml" "$@"
}
dc config --quiet
dc build --pull
```

Keep `compose.env` shell-compatible, with simple unquoted values as in the
example. The `--env-file` settings are Compose substitutions, not game environment
variables. The runtime only receives Nexus's existing container settings.

## Prepare both games

Push the working game revisions from the PC first, including their game-owned
assets where appropriate. Use the actual repository URLs and selected commit
IDs below; angle-bracket values are placeholders. Private repositories need host
read access, preferably read-only deploy keys. Keep credentials outside the game
folders and out of remote URLs: `/games` is readable by the runtime.

```bash
git clone <pirate-repo-url> "$NEXUS_HOME/games/pirate-island"
git clone <captain-repo-url> "$NEXUS_HOME/games/captain-flip"
bash "$NEXUS_REPO/deploy/update-game.sh" pirate-island --ref <pirate-commit>
bash "$NEXUS_REPO/deploy/update-game.sh" captain-flip --ref <captain-commit>
cp "$NEXUS_REPO/deploy/nexus.config.vm.example.json" "$NEXUS_HOME/config/nexus.config.json"
```

The updater validates manifest schema 3, checks out the requested commit, installs
locked dependencies in a disposable container using the Nexus image, builds,
then removes development dependencies. Do not transfer Windows `node_modules`.
Keep the default readable clone/build permissions (`umask 022`); installers run
as the host owner, while the runtime image uses its unprivileged `node` user.

Edit `publicOrigin` in the copied config to `http://<VM-LAN-IP>:8400` (or the
chosen port). It controls Open/QR/share links; it does not set the listening
address. Its address and port must match the player-reachable Compose binding.
The game paths are container paths, independent of their locations on the PC.

Validate the library from the runtime identity before starting the service:

```bash
docker run --rm --network none --read-only \
  --mount "type=bind,src=$NEXUS_HOME/config,dst=/config,readonly" \
  --mount "type=bind,src=$NEXUS_HOME/games,dst=/games,readonly" \
  "$NEXUS_IMAGE" node --input-type=module -e '
    import { loadLibraryConfiguration } from "/app/src/registry.js";
    const library = await loadLibraryConfiguration("/config/nexus.config.json");
    console.log(library.games.map(game => game.manifest.id).join("\n"));
  '
dc up -d --no-build --pull never --wait
curl --fail "http://$NEXUS_BIND_IP:$NEXUS_PORT/healthz"
```

Open the VM LAN URL on a phone, choose **Start**, then use the game QR/link.
Captain Flip also offers **Open board display**. Stop/switch in the portal when
changing games. No game listener or additional game port needs publishing.

## Keep it running

Three existing controls make this always-on: Proxmox starts the VM, Debian starts
Docker, and Docker's `unless-stopped` policy restarts the Nexus container. No
second systemd supervisor or scheduled restart is needed. An intentionally
stopped container stays stopped; use `dc up -d --no-build --pull never --wait`
to resume it. Docker documents the policy in
[Start containers automatically](https://docs.docker.com/engine/containers/start-containers-automatically/).

The healthcheck reports portal health; it does not automatically restart an
unhealthy process or start a game. A game failure is handled by Nexus and shown
in the portal. Container stop gets 30 seconds for orderly shutdown, including
the active game. For maintenance, stop the game in the portal first.

Do one VM reboot outside a live session, then confirm that the same LAN URL and
QR work and the library returns with no game running. This is the useful migration
check: the installation no longer depends on the PC or an open SSH session.

## Updates and rollback

Use deliberate updates outside a game session. Avoid automatic container updates
that would end a table's game unexpectedly. Load the shell settings/functions
above before running the commands below.

For a game update, stop Nexus for the maintenance window so nobody can start a
game while files are being replaced:

```bash
dc stop
git -C "$NEXUS_HOME/games/pirate-island" rev-parse HEAD
bash "$NEXUS_REPO/deploy/update-game.sh" pirate-island --ref <new-commit>
dc up -d --no-build --pull never --wait
```

Save the printed previous commit. If installation fails, leave Nexus stopped,
fix/retry the installer, or run it with `--ref <previous-commit>`. Only bring
the service back after a successful install. The same commands work for
`captain-flip`. The updater discards tracked local edits in these deploy-only
clones; retain personal assets/source in their own repository or backup.

For a Nexus update, save the current image tag and Nexus commit, stop the game,
then:

```bash
dc stop
cd "$NEXUS_REPO"
git rev-parse HEAD
git fetch origin
git checkout --detach <new-nexus-commit>
# Edit compose.env to a NEW NEXUS_IMAGE tag, then reload it with set -a as above.
dc build --pull
dc up -d --no-build --pull never --wait
```

Keep the old image and matching source revision. To roll back Nexus, stop the
service, check out that previous revision, restore its image tag in `compose.env`,
reload the settings, and run `dc up -d --no-build --pull never --wait`. No rebuild
is needed. If the Node/runtime image changes, reinstall game dependencies with
the new image (`update-game.sh <folder> --ref <game-commit> --reinstall`) while
Nexus is stopped; rolling back the image may require the matching reinstall too.

## Backups and troubleshooting

Include this VM in the normal Proxmox backup job. Keep `config/`, `compose.env`,
game source/personal assets, `.update-game/`, and the Nexus/game revision choices.
A full VM backup also retains local Docker images for rollback. A source-only
restore must rebuild the Nexus image and run the game updater with `--reinstall`
before starting. Game sessions are currently in memory; backups do not save a
live table. Restore a copied VM with its NIC disconnected or on an isolated
network first to avoid conflicting with the original VM's IP.

Use these commands on the VM:

```bash
dc ps
dc logs --tail 100
docker stats --no-stream tabletop-nexus
df -h
docker exec tabletop-nexus cat /tmp/tabletop-nexus-1000/runtime-diagnostics.json
```

The diagnostics file appears after a game launch and is lost on container stop;
copy useful failure details before maintenance. Docker logs rotate at three
10 MiB files. A port conflict needs the other listener identified or a new
`NEXUS_PORT`; change `publicOrigin` to match. A missing-game/library error usually
means wrong `/games/...` paths, unreadable files, or an invalid schema-3 manifest.
A startup failure usually needs the game installer rerun or its diagnostics read.
If only phones fail to connect, check the reserved IP, LAN/VLAN routing and
Proxmox firewall before changing game ports.

Actual deployment needs the VM address, game repository access and chosen release
commits; this repository change does not claim the Proxmox guest has been deployed.
