#!/usr/bin/env bash
# Update one bind-mounted Nexus game from its git remote, then install its
# dependencies inside the Nexus image so they match the runtime Nexus uses.
#
#   update-game.sh <folder> [--ref <branch|tag|commit>] [--reinstall] [--force]
#
# <folder> is the game's directory name under $NEXUS_HOME/games. Run on the
# Docker host as a user that owns the game clones and can use docker. See
# deploy/README.md.
set -euo pipefail

NEXUS_HOME="${NEXUS_HOME:-/srv/homestack/nexus}"
NEXUS_CONTAINER="${NEXUS_CONTAINER:-tabletop-nexus}"
NEXUS_IMAGE="${NEXUS_IMAGE:-tabletop-nexus:local}"
GAMES_DIR="$NEXUS_HOME/games"

die() { echo "update-game: $*" >&2; exit 1; }
note() { echo "update-game: $*"; }

usage() {
  cat <<'EOF'
Usage: update-game.sh <folder> [--ref <branch|tag|commit>] [--reinstall] [--force]

  <folder>      game directory name under $NEXUS_HOME/games (a git clone)
  --ref REF     check out REF instead of the remote's default branch
                (a branch name means origin/<branch>; use a commit to roll back)
  --reinstall   reinstall dependencies even when the commit is unchanged
  --force       skip the "game must not be running" check; use only when
                Nexus cannot answer and you know this game is not running
EOF
}

name=""
ref=""
reinstall=0
force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) [[ $# -ge 2 ]] || die "--ref needs a value"; ref="$2"; shift 2 ;;
    --reinstall) reinstall=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) [[ -z "$name" ]] || die "only one game folder per run"; name="$1"; shift ;;
  esac
done

[[ -n "$name" ]] || { usage >&2; exit 2; }
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid folder name: $name"
dir="$GAMES_DIR/$name"
[[ -d "$dir/.git" ]] || die "$dir is not a git clone (clone it there first; see deploy/README.md)"
docker image inspect "$NEXUS_IMAGE" >/dev/null 2>&1 \
  || die "image $NEXUS_IMAGE not found; build it with: docker compose -f deploy/compose.yaml build"

# --- 1. Resolve the target commit -------------------------------------------
git -C "$dir" fetch --prune --tags --quiet origin
if [[ -z "$ref" ]]; then
  ref="$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD)" \
    || die "origin's default branch is unknown; run 'git -C $dir remote set-head origin --auto' or pass --ref"
fi
# Prefer the remote branch: a local branch of the same name is a stale clone-time copy.
target="$(git -C "$dir" rev-parse --verify --quiet "origin/$ref^{commit}" \
  || git -C "$dir" rev-parse --verify --quiet "$ref^{commit}")" \
  || die "cannot resolve ref: $ref"
current="$(git -C "$dir" rev-parse HEAD)"
# The commit whose dependencies were last installed successfully. Kept outside
# the clone so the game's working tree stays clean.
state_file="$NEXUS_HOME/.update-game/$name"
installed="$(cat "$state_file" 2>/dev/null || true)"

# --- 2. Validate the target manifest with Nexus's own parser ----------------
# A broken boardgame.json fails the whole library, so check before checkout.
manifest_id() {
  docker run --rm -i --network none "$NEXUS_IMAGE" node --input-type=module -e '
    import { parseManifest } from "/app/src/registry.js";
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    try {
      const manifest = JSON.parse(raw);
      parseManifest(manifest);
      console.log(manifest.id);
    } catch (error) {
      console.error(`  ${error.message}`);
      process.exit(1);
    }
  '
}
target_manifest="$(git -C "$dir" show "$target:boardgame.json" 2>/dev/null)" \
  || die "no boardgame.json at $(git -C "$dir" rev-parse --short "$target")"
game_id="$(manifest_id <<<"$target_manifest")" \
  || die "boardgame.json at $(git -C "$dir" rev-parse --short "$target") is not a valid schema-3 manifest"
current_id="$(git -C "$dir" show HEAD:boardgame.json 2>/dev/null | manifest_id 2>/dev/null || true)"

# --- 3. Refuse while this game is running -----------------------------------
# Updating files under a running game mixes old and new code mid-session.
check_not_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$NEXUS_CONTAINER" 2>/dev/null || true)" == "true" ]] \
    || return 0  # Nexus is down, so no game can be running.
  local active
  active="$(docker exec "$NEXUS_CONTAINER" node -e '
    fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/games`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => console.log(b.busy ? "<busy>" : (b.runtime?.gameId ?? "<none>")))
      .catch((e) => { console.error(e.message); process.exit(1); });
  ')" || die "could not read Nexus state; refusing to update (fix Nexus, or use --force if this game is certainly not running)"
  [[ "$active" != "<busy>" ]] || die "Nexus is starting or stopping a game; try again in a moment"
  if [[ "$active" == "$game_id" || ( -n "$current_id" && "$active" == "$current_id" ) ]]; then
    die "$active is the active game; stop it in the portal first"
  fi
}
if [[ $force -eq 1 ]]; then
  note "--force: skipping the running-game check"
else
  check_not_running
fi

# --- 4. Check out the target ------------------------------------------------
short="$(git -C "$dir" rev-parse --short "$target")"
if [[ "$target" != "$current" ]]; then
  if [[ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]]; then
    note "discarding local edits in $dir (the server copy is deploy-only)"
  fi
  note "$name: $(git -C "$dir" rev-parse --short "$current") -> $short"
  git -C "$dir" --no-pager log --oneline --no-decorate "$current..$target" 2>/dev/null | sed 's/^/    /' || true
  git -C "$dir" checkout --quiet --detach --force "$target"
elif [[ $reinstall -eq 0 && "$installed" == "$target" ]]; then
  note "$name is already at $short; nothing to do (use --reinstall to reinstall dependencies)"
  exit 0
fi

# --- 5. Install dependencies inside the Nexus image -------------------------
# Same Linux + Node as the runtime, so native modules match. Games with a
# "build" script get full deps, build, then dev deps are pruned.
if [[ -f "$dir/package.json" ]]; then
  [[ -f "$dir/package-lock.json" ]] \
    || die "$name has package.json but no package-lock.json; commit a lockfile so installs are reproducible"
  note "installing dependencies"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e npm_config_cache=/tmp/.npm -e npm_config_update_notifier=false \
    -v "$dir:/work" -w /work \
    "$NEXUS_IMAGE" sh -c '
      set -e
      if node -e "process.exit(require(\"./package.json\").scripts?.build ? 0 : 1)"; then
        npm ci --include=dev --no-audit --no-fund
        npm run build
        npm prune --omit=dev --no-audit --no-fund
      else
        npm ci --omit=dev --no-audit --no-fund
      fi
    '
else
  note "no package.json; nothing to install"
fi
mkdir -p "$(dirname "$state_file")"
echo "$target" > "$state_file"

# --- 6. Final checks --------------------------------------------------------
config="$NEXUS_HOME/nexus.config.json"
if [[ ! -f "$config" ]] || ! grep -q "\"/games/$name\"" "$config"; then
  note "warning: $config does not list this game; add { \"path\": \"/games/$name\" } to its games array"
fi
note "$game_id is at $short ($(git -C "$dir" log -1 --format=%s)). Start it from the portal."
