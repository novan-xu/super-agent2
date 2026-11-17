set -euo pipefail

root=/share/Container/superagent2
old=/share/Container/superagent
project=superagent2
hub_port=18180
nas_user=novanxu
docker_bin=${DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
old_containers=(superagent-tunnel superagent-brain superagent-hub)
old_codex_volume=superagent-brain-codex-home

say() {
  printf 'superagent2 deploy: %s\n' "$*" >&2
}

fail() {
  say "$*"
  exit 1
}

docker_cli() {
  if [ ! -x "$docker_bin" ]; then
    docker_bin=$(command -v docker || true)
    [ -n "$docker_bin" ] || fail "no docker client found"
  fi
  if [ -z "${DOCKER_CONFIG:-}" ]; then
    export DOCKER_CONFIG="$root/.docker"
    mkdir -p "$DOCKER_CONFIG"
    chmod 0700 "$DOCKER_CONFIG"
  fi
  "$docker_bin" "$@"
}

compose() {
  docker_cli compose -p "$project" -f "$root/src/deploy/compose.yaml" "$@"
}

own_path() {
  case "$1" in
    "$root"/*) ;;
    *) fail "refusing to act on $1, which is outside $root" ;;
  esac
  case "$1" in
    *..*) fail "refusing to act on $1, which climbs out of $root" ;;
  esac
}

own_name() {
  case "$1" in
    superagent2 | superagent2-* | superagent2_*) ;;
    *) fail "refusing to act on $1, which is not a superagent2 name" ;;
  esac
}

remove_tree() {
  own_path "$1"
  rm -rf -- "$1"
}

valid_commit() {
  [[ "$1" =~ ^[0-9a-f]{7,40}$ ]] || fail "$1 is not a commit id"
}

step_source() {
  local commit=${1:-}
  valid_commit "$commit"
  local archive="$root/incoming/$commit.tar"
  [ -f "$archive" ] || fail "no archive at $archive; upload one with git archive first"
  say "about to unpack $archive into $root/src, keeping the current source as $root/src.previous"
  mkdir -p "$root"
  remove_tree "$root/src.new"
  mkdir -p "$root/src.new"
  tar -xf "$archive" -C "$root/src.new"
  [ -f "$root/src.new/deploy/compose.yaml" ] || fail "the archive holds no deploy/compose.yaml"
  printf '%s\n' "$commit" > "$root/src.new/.revision"
  if [ -d "$root/src" ]; then
    remove_tree "$root/src.previous"
    mv "$root/src" "$root/src.previous"
  fi
  mv "$root/src.new" "$root/src"
  install -m 0700 "$root/src/deploy/deploy.sh" "$root/deploy.sh.new"
  mv "$root/deploy.sh.new" "$root/deploy.sh"
  mkdir -p "$root/projects"
  say "source of $commit is in $root/src, and $root/deploy.sh is its deploy script"
}

copy_value() {
  local name=$1 target=$2 required=$3
  shift 3
  local file line value
  for file in "$@"; do
    [ -r "$old/secrets/$file" ] || continue
    line=$(grep -E "^(export[[:space:]]+)?${name}=" "$old/secrets/$file" | tail -n 1 || true)
    [ -n "$line" ] || continue
    case "$line" in
      export[[:space:]]*)
        line=${line#export}
        line=${line#"${line%%[![:space:]]*}"}
        ;;
    esac
    value=${line#*=}
    value=${value%\"}
    value=${value#\"}
    value=${value%\'}
    value=${value#\'}
    if [ -z "$value" ]; then
      continue
    fi
    printf '%s\n' "$line" >> "$target"
    say "copied $name from $old/secrets/$file"
    return 0
  done
  if [ "$required" = required ]; then
    say "missing $name in $old/secrets ($*)"
    return 1
  fi
  say "no value for $name; it stays unset"
  return 0
}

write_env() {
  local target=$1
  shift
  own_path "$target"
  if [ -e "$target" ]; then
    say "$target exists and is kept; delete it by hand to copy it again"
    return 0
  fi
  local draft="$target.draft"
  remove_tree "$draft"
  : > "$draft"
  chmod 0600 "$draft"
  local missing=0 spec
  for spec in "$@"; do
    local name=${spec%%:*} rest=${spec#*:}
    local required=${rest%%:*} files=${rest#*:}
    local list
    IFS=, read -r -a list <<< "$files"
    copy_value "$name" "$draft" "$required" "${list[@]}" || missing=1
  done
  if [ "$missing" -ne 0 ]; then
    remove_tree "$draft"
    fail "$target was not written because a required value is missing"
  fi
  mv "$draft" "$target"
  say "wrote $target"
}

step_secrets() {
  say "about to prepare $root/secrets: values copied by name from $old/secrets, and a new SSH key for the hub"
  umask 077
  mkdir -p "$root/secrets/ssh"
  chmod 0700 "$root/secrets" "$root/secrets/ssh"
  write_env "$root/secrets/hub.env" \
    "ACCESS_TEAM:required:hub.env,access.env" \
    "ACCESS_AUD:required:hub.env,access.env" \
    "OWNER_EMAIL:required:hub.env,access.env" \
    "GITHUB_TOKEN_NOVAN_XU:required:github.env" \
    "GITHUB_TOKEN_NUOFAN_ISLAND:required:github.env" \
    "CLOUDFLARE_ACCOUNT_ID:optional:hub.env,cloudflare.env" \
    "CLOUDFLARE_ACCESS_API_TOKEN:optional:hub.env" \
    "CLOUDFLARE_API_TOKEN:optional:cloudflare.env" \
    "WOODPECKER_SERVER:optional:hub.env" \
    "WOODPECKER_TOKEN:optional:hub.env" \
    "VAPID_PUBLIC_KEY:optional:hub.env" \
    "VAPID_PRIVATE_KEY:optional:hub.env"
  write_env "$root/secrets/brain.env" \
    "BRAIN_CLAUDE_OAUTH_TOKEN:optional:brain.env"
  write_env "$root/secrets/tunnel.env" \
    "TUNNEL_TOKEN:required:tunnel.env"
  local key="$root/secrets/ssh/nas_ed25519"
  if [ -e "$key" ]; then
    say "$key exists and is kept"
  else
    ssh-keygen -q -t ed25519 -N "" -C "superagent2-hub" -f "$key" < /dev/null
    say "generated $key"
  fi
  chmod 0600 "$root/secrets/hub.env" "$root/secrets/brain.env" "$root/secrets/tunnel.env" "$key"
  chmod 0644 "$key.pub"
  say "the brain's token to the hub is made by the hub at its first start, on volume superagent2-brain-link"
}

step_build() {
  local revision
  revision=$(cat "$root/src/.revision")
  valid_commit "$revision"
  say "about to build superagent2-hub and superagent2-brain from $root/src at $revision"
  local image
  for image in superagent2-hub superagent2-brain; do
    own_name "$image"
    if docker_cli image inspect "$image:current" > /dev/null 2>&1; then
      docker_cli tag "$image:current" "$image:previous"
      say "kept the image being replaced as $image:previous"
    fi
  done
  compose build hub brain
  for image in superagent2-hub superagent2-brain; do
    docker_cli tag "$image:current" "$image:$revision"
  done
  say "built superagent2-hub:current and superagent2-brain:current, also tagged $revision"
}

step_codex_login() {
  own_name superagent2-brain-codex
  say "about to copy the Codex login (auth.json only) from volume $old_codex_volume, mounted read-only, into volume superagent2-brain-codex"
  docker_cli volume inspect "$old_codex_volume" > /dev/null || fail "volume $old_codex_volume does not exist"
  compose run --rm --no-deps --name superagent2-codex-login-copy \
    --volume "$old_codex_volume:/old:ro" \
    --entrypoint bash brain -c '
      set -eu
      if [ -e /home/node/.codex/auth.json ]; then
        echo "superagent2 deploy: superagent2-brain-codex already holds auth.json; it is kept" >&2
        exit 0
      fi
      [ -s /old/auth.json ] || { echo "superagent2 deploy: the old volume holds no auth.json" >&2; exit 1; }
      cp /old/auth.json /home/node/.codex/auth.json.copy
      chmod 0600 /home/node/.codex/auth.json.copy
      mv /home/node/.codex/auth.json.copy /home/node/.codex/auth.json
      echo "superagent2 deploy: copied auth.json" >&2
    '
}

step_up() {
  say "about to start superagent2-hub and superagent2-brain in project $project, the hub on 127.0.0.1:$hub_port"
  mkdir -p "$root/projects"
  compose up -d hub brain
}

hub_answers() {
  curl --silent --max-time 5 "http://127.0.0.1:$hub_port/health" 2> /dev/null | grep -q '"status":"ok"'
}

step_health() {
  say "about to check superagent2-hub's health on 127.0.0.1:$hub_port and the brain's link"
  local tries=0
  until hub_answers; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || fail "the hub does not answer its health check"
    sleep 2
  done
  say "the hub answers {\"status\":\"ok\"}"
  tries=0
  local started last
  until
    started=$(docker_cli inspect -f '{{.State.StartedAt}}' superagent2-brain 2> /dev/null || true)
    last=$(docker_cli logs --since "${started:-1970-01-01T00:00:00Z}" superagent2-brain 2>&1 | grep -E 'Linked to the hub|link to the hub' | tail -n 1 || true)
    [ "$last" = "Linked to the hub" ]
  do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || fail "the brain is not linked to the hub; last link message: ${last:-none}"
    sleep 2
  done
  say "the brain is linked to the hub"
}

step_authorize() {
  local key="$root/secrets/ssh/nas_ed25519.pub"
  [ -r "$key" ] || fail "no public key at $key; run the secrets step first"
  [ "$(id -un)" = "$nas_user" ] || fail "run this step as $nas_user, the user the hub signs in as"
  local keys="$HOME/.ssh/authorized_keys"
  say "about to authorize the hub's key for $nas_user in $keys, from container networks only; no other user and no sshd setting changes"
  local body
  body=$(awk '{print $2}' "$key")
  mkdir -p "$HOME/.ssh"
  chmod 0700 "$HOME/.ssh"
  touch "$keys"
  chmod 0600 "$keys"
  if grep -qF "$body" "$keys"; then
    say "the hub's key is already authorized"
  else
    mkdir -p "$root/backups"
    cp -p "$keys" "$root/backups/authorized_keys.$(date +%Y%m%d%H%M%S)"
    printf 'from="10.0.0.0/8,172.16.0.0/12",no-agent-forwarding,no-X11-forwarding %s\n' "$(cat "$key")" >> "$keys"
    say "authorized the hub's key; the previous file is in $root/backups"
  fi
  if docker_cli inspect -f '{{.State.Running}}' superagent2-hub 2> /dev/null | grep -q true; then
    compose exec -T hub ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i /run/superagent2/ssh/nas_ed25519 "$nas_user@host.docker.internal" true < /dev/null
    say "the hub signs in to the NAS host"
  fi
}

step_deauthorize() {
  local key="$root/secrets/ssh/nas_ed25519.pub"
  local keys="$HOME/.ssh/authorized_keys"
  [ -r "$key" ] || fail "no public key at $key"
  say "about to remove the hub's key from $keys"
  local body
  body=$(awk '{print $2}' "$key")
  if ! grep -qF "$body" "$keys"; then
    say "the hub's key is not authorized"
    return 0
  fi
  mkdir -p "$root/backups"
  cp -p "$keys" "$root/backups/authorized_keys.$(date +%Y%m%d%H%M%S)"
  grep -vF "$body" "$keys" > "$keys.superagent2" || true
  chmod 0600 "$keys.superagent2"
  mv "$keys.superagent2" "$keys"
  say "removed the hub's key"
}

step_stop() {
  say "about to stop superagent2-hub and superagent2-brain, keeping their containers, volumes and images"
  compose stop brain hub
}

step_status() {
  compose --profile tunnel ps -a
}

step_takeover() {
  [ -s "$root/secrets/tunnel.env" ] || fail "$root/secrets/tunnel.env is missing"
  grep -q '^TUNNEL_TOKEN=.' "$root/secrets/tunnel.env" || fail "$root/secrets/tunnel.env holds no TUNNEL_TOKEN"
  step_up
  step_health
  say "about to stop the first Super-agent's ${old_containers[*]} (kept with their volumes, not removed), then start superagent2-tunnel"
  docker_cli stop superagent-tunnel superagent-brain superagent-hub
  compose --profile tunnel up -d tunnel
  say "superagent2-tunnel is started; the host name now reaches superagent2-hub"
}

step_giveback() {
  say "about to stop superagent2-tunnel, superagent2-brain and superagent2-hub, then start the first Super-agent's superagent-hub, superagent-brain and superagent-tunnel again"
  compose --profile tunnel stop tunnel brain hub
  docker_cli start superagent-hub superagent-brain superagent-tunnel
  say "the first Super-agent is running again"
}

step_release() {
  local commit=${1:-}
  step_source "$commit"
  step_build
  step_up
  step_health
}

step_rollback() {
  [ -d "$root/src.previous" ] || fail "there is no $root/src.previous to go back to"
  local image
  for image in superagent2-hub superagent2-brain; do
    docker_cli image inspect "$image:previous" > /dev/null 2>&1 || fail "there is no $image:previous to go back to"
  done
  say "about to go back to the previous source and the images tagged previous"
  remove_tree "$root/src.rolledback"
  mv "$root/src" "$root/src.rolledback"
  mv "$root/src.previous" "$root/src"
  mv "$root/src.rolledback" "$root/src.previous"
  for image in superagent2-hub superagent2-brain; do
    docker_cli tag "$image:current" "$image:rolledback"
    docker_cli tag "$image:previous" "$image:current"
    docker_cli tag "$image:rolledback" "$image:previous"
    docker_cli rmi "$image:rolledback" > /dev/null
  done
  step_up
  step_health
}

usage() {
  cat >&2 << 'USAGE'
usage: bash /share/Container/superagent2/deploy.sh <step> [commit]
steps, in order for a first deployment:
  source <commit>  unpack /share/Container/superagent2/incoming/<commit>.tar into src
  secrets          prepare secrets from the first Super-agent's files and a new SSH key
  build            build superagent2-hub and superagent2-brain
  codex-login      copy the Codex login into volume superagent2-brain-codex
  up               start hub and brain
  health           check the hub's health and the brain's link
  authorize        let the hub sign in to the NAS host as novanxu
other steps:
  release <commit> source, build, up and health
  rollback         go back to the previous source and images
  stop             stop hub and brain
  status           list the project's containers
  deauthorize      withdraw the hub's NAS key
  takeover         stop superagent-tunnel, superagent-brain and superagent-hub, start superagent2-tunnel
  giveback         stop superagent2, start superagent-hub, superagent-brain and superagent-tunnel
USAGE
  exit 2
}

main() {
  local step=${1:-}
  [ "$#" -gt 0 ] && shift
  case "$step" in
    source) step_source "$@" ;;
    secrets) step_secrets ;;
    build) step_build ;;
    codex-login) step_codex_login ;;
    up) step_up ;;
    health) step_health ;;
    authorize) step_authorize ;;
    deauthorize) step_deauthorize ;;
    release) step_release "$@" ;;
    rollback) step_rollback ;;
    stop) step_stop ;;
    status) step_status ;;
    takeover) step_takeover ;;
    giveback) step_giveback ;;
    *) usage ;;
  esac
}

main "$@"
