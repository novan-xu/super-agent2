set -euo pipefail

script=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -L)/$(basename -- "${BASH_SOURCE[0]}")
root=${SUPERAGENT2_ROOT:-$(dirname -- "$script")}
instance=$(basename -- "$root")
old=/share/Container/superagent
repository=novan-xu/super-agent2
token_name=GITHUB_TOKEN_NOVAN_XU
docker_bin=${DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
old_codex_volume=superagent-brain-codex-home
releases_kept=5
hub_tries=90
brain_tries=60

say() {
  printf '%s %s deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$instance" "$*" >&2
}

fail() {
  say "$*"
  exit 1
}

case "$instance" in
  superagent2 | superagent2-*) ;;
  *) fail "this script lives in $root, which is not a superagent2 folder" ;;
esac
case "$instance" in
  *[!a-z0-9-]*) fail "$instance is not a plain lower-case name" ;;
esac

project=$instance

setting() {
  local file="$root/instance.env"
  [ -r "$file" ] || return 0
  sed -n "s/^$1=//p" "$file" | tail -n 1
}

hub_port=$(setting HUB_PORT)
if [ -z "$hub_port" ]; then
  [ "$instance" = superagent2 ] || fail "$root/instance.env names no HUB_PORT"
  hub_port=18180
fi
[[ "$hub_port" =~ ^[0-9]+$ ]] || fail "HUB_PORT $hub_port is not a port"

export SUPERAGENT2_PROJECT=$project SUPERAGENT2_ROOT=$root SUPERAGENT2_HUB_PORT=$hub_port
export SUPERAGENT2_SOURCE=$root/src SUPERAGENT2_TAG=current SUPERAGENT2_REVISION=

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

parameterised() {
  [ -f "$1" ] && grep -q 'SUPERAGENT2_PROJECT' "$1"
}

compose_with() {
  local file=$1
  shift
  docker_cli compose -p "$project" -f "$file" "$@"
}

compose() {
  [ -f "$root/compose.yaml" ] || fail "there is no $root/compose.yaml; put deploy/compose.yaml there first"
  compose_with "$root/compose.yaml" "$@"
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
    "$project" | "$project"-*) ;;
    *) fail "refusing to act on $1, which is not a $project name" ;;
  esac
}

remove_tree() {
  own_path "$1"
  rm -rf -- "$1"
}

valid_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "$1 is not a full commit id"
}

revision_of() {
  [ -f "$1/.revision" ] && head -n 1 "$1/.revision" || true
}

github_token() {
  if [ -n "${GH_TOKEN:-}" ]; then
    printf '%s' "$GH_TOKEN"
    return 0
  fi
  local line value
  line=$(grep -E "^(export[[:space:]]+)?${token_name}=" "$root/secrets/hub.env" 2> /dev/null | tail -n 1 || true)
  value=${line#*=}
  value=${value%\"}
  value=${value#\"}
  value=${value%\'}
  value=${value#\'}
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

fetch_source() {
  local commit=$1 target=$2
  own_path "$target"
  remove_tree "$target"
  mkdir -p "$target" "$root/incoming"
  local archive="$root/incoming/$commit.tar"
  if [ -f "$archive" ]; then
    say "unpacking the uploaded $archive"
    tar -xf "$archive" -C "$target" || return 1
  else
    local packed="$root/incoming/$commit.tar.gz" token
    token=$(github_token) || {
      say "there is no $token_name in $root/secrets/hub.env to fetch $repository with"
      return 1
    }
    say "fetching $repository at $commit from GitHub"
    printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --fail --silent --show-error --location --max-time 900 --config - \
      --header "Accept: application/vnd.github+json" --header "User-Agent: superagent2-deploy" \
      --output "$packed.part" "https://api.github.com/repos/$repository/tarball/$commit" || {
      rm -f -- "$packed.part"
      return 1
    }
    token=
    mv "$packed.part" "$packed"
    tar -xzf "$packed" -C "$target" --strip-components=1 || return 1
    rm -f -- "$packed"
  fi
  [ -f "$target/deploy/Dockerfile" ] || {
    say "the source of $commit holds no deploy/Dockerfile"
    return 1
  }
  printf '%s\n' "$commit" > "$target/.revision"
}

build_images() {
  local source=$1 commit=$2 file
  file="$source/deploy/compose.yaml"
  if ! parameterised "$file"; then
    say "the compose file of $commit is from before this script; building with $root/compose.yaml"
    file="$root/compose.yaml"
  fi
  say "building $project-hub:$commit and $project-brain:$commit from $source while the running version goes on"
  SUPERAGENT2_SOURCE=$source SUPERAGENT2_TAG=$commit SUPERAGENT2_REVISION=$commit compose_with "$file" build hub brain
}

database_level() {
  local image=$1 dir=$2 mode=$3
  own_name "$image"
  docker_cli run --rm --name "$project-database" --network none \
    --volume "$project-hub-data:/data" --volume "$dir:/backup" \
    --entrypoint node "$image" -e '
      const fs = require("node:fs");
      const { DatabaseSync } = require("node:sqlite");
      const mode = process.argv[1];
      if (!fs.existsSync("/data/hub.sqlite")) {
        process.stdout.write("none");
        process.exit(0);
      }
      const database = new DatabaseSync("/data/hub.sqlite");
      const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS level FROM migrations").get();
      if (mode === "backup") {
        database.exec("VACUUM INTO \x27/backup/hub.sqlite\x27");
      }
      database.close();
      process.stdout.write(String(row.level));
    ' "$mode" 2> /dev/null
}

restore_database() {
  local image=$1 dir=$2
  own_name "$image"
  docker_cli run --rm --name "$project-database" --network none \
    --volume "$project-hub-data:/data" --volume "$dir:/backup" \
    --entrypoint sh "$image" -c '
      set -e
      [ -s /backup/hub.sqlite ]
      mkdir -p /backup/replaced
      for name in hub.sqlite hub.sqlite-wal hub.sqlite-shm; do
        if [ -e "/data/$name" ]; then
          cp -p "/data/$name" "/backup/replaced/$name"
          rm -f "/data/$name"
        fi
      done
      cp /backup/hub.sqlite /data/hub.sqlite.restoring
      mv /data/hub.sqlite.restoring /data/hub.sqlite
    '
}

hub_answers() {
  local expected=$1 body
  body=$(curl --silent --max-time 5 "http://127.0.0.1:$hub_port/health" 2> /dev/null || true)
  case "$body" in
    *'"status":"ok"'*) ;;
    *) return 1 ;;
  esac
  case "$body" in
    *'"version":'*) [ -z "$expected" ] || [[ "$body" == *"\"version\":\"$expected\""* ]] ;;
    *) return 0 ;;
  esac
}

wait_for_hub() {
  local expected=$1 tries=0
  until hub_answers "$expected"; do
    tries=$((tries + 1))
    [ "$tries" -lt "$hub_tries" ] || return 1
    sleep 2
  done
}

brain_linked() {
  local started last
  started=$(docker_cli inspect -f '{{.State.StartedAt}}' "$project-brain" 2> /dev/null || true)
  last=$(docker_cli logs --since "${started:-1970-01-01T00:00:00Z}" "$project-brain" 2>&1 | grep -E 'Linked to the hub|link to the hub' | tail -n 1 || true)
  [ "$last" = "Linked to the hub" ]
}

wait_for_brain() {
  local tries=0
  until brain_linked; do
    tries=$((tries + 1))
    [ "$tries" -lt "$brain_tries" ] || return 1
    sleep 2
  done
}

healthy() {
  local expected=$1
  if ! wait_for_hub "$expected"; then
    say "the hub on 127.0.0.1:$hub_port did not answer its health check${expected:+ as $expected}"
    return 1
  fi
  say "the hub answers its health check${expected:+ as $expected}"
  if ! wait_for_brain; then
    say "the brain did not link to the hub"
    return 1
  fi
  say "the brain is linked to the hub"
}

start_services() {
  local expected=$1
  compose up -d --no-deps hub || return 1
  if ! wait_for_hub "$expected"; then
    say "the hub on 127.0.0.1:$hub_port did not answer its health check${expected:+ as $expected}"
    return 1
  fi
  say "the hub answers its health check${expected:+ as $expected}"
  compose up -d --no-deps brain || return 1
  if ! wait_for_brain; then
    say "the brain did not link to the hub"
    return 1
  fi
  say "the brain is linked to the hub"
}

record_set() {
  local file="$1/state" key=$2 value
  value=$(printf '%s' "$3" | tr '\n\r\t' '   ')
  {
    grep -v "^$key=" "$file" 2> /dev/null || true
    printf '%s=%s\n' "$key" "$value"
  } > "$file.next"
  mv "$file.next" "$file"
}

record_get() {
  [ -f "$1/state" ] || return 0
  sed -n "s/^$2=//p" "$1/state" | tail -n 1
}

release_alive() {
  local pid
  pid=$(record_get "$1" pid)
  [ -n "$pid" ] || return 0
  [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'run-release'
}

running_release() {
  local dir
  for dir in "$root"/releases/*; do
    [ -d "$dir" ] || continue
    if [ "$(record_get "$dir" state)" = running ] && release_alive "$dir"; then
      basename -- "$dir"
      return 0
    fi
  done
}

finish() {
  local dir=$1 result=$2 reason=$3
  record_set "$dir" reason "$reason"
  record_set "$dir" ended "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record_set "$dir" step done
  record_set "$dir" state "$result"
  say "release $(basename -- "$dir") ended $result: $reason"
}

prune() {
  local keep=0 dir name
  if [ -d "$root/releases" ]; then
    for name in $(ls -1t "$root/releases"); do
      dir="$root/releases/$name"
      [ -d "$dir" ] || continue
      if [ "$(record_get "$dir" state)" = running ]; then
        continue
      fi
      keep=$((keep + 1))
      [ "$keep" -gt "$releases_kept" ] || continue
      remove_tree "$dir"
    done
  fi
  local current previous image tag
  current=$(revision_of "$root/src")
  previous=$(revision_of "$root/src.previous")
  for image in "$project-hub" "$project-brain"; do
    own_name "$image"
    for tag in $(docker_cli image ls --format '{{.Tag}}' "$image" 2> /dev/null || true); do
      [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue
      [ "$tag" = "$current" ] || [ "$tag" = "$previous" ] || docker_cli rmi "$image:$tag" > /dev/null 2>&1 || true
    done
  done
}

start_running() {
  start_services "" || true
}

install_deploy_files() {
  local source=$1
  if parameterised "$source/deploy/compose.yaml" && [ -f "$source/deploy/deploy.sh" ]; then
    remove_tree "$root/deploy.previous"
    mkdir -p "$root/deploy.previous"
    [ ! -f "$root/compose.yaml" ] || cp -p "$root/compose.yaml" "$root/deploy.previous/compose.yaml"
    [ ! -f "$root/deploy.sh" ] || cp -p "$root/deploy.sh" "$root/deploy.previous/deploy.sh"
    install -m 0644 "$source/deploy/compose.yaml" "$root/compose.yaml.next"
    mv "$root/compose.yaml.next" "$root/compose.yaml"
    install -m 0700 "$source/deploy/deploy.sh" "$root/deploy.sh.next"
    mv "$root/deploy.sh.next" "$root/deploy.sh"
    say "installed deploy.sh and compose.yaml of $(revision_of "$source") in $root"
  else
    say "the source of $(revision_of "$source") has no deploy files this script can use; $root/deploy.sh and $root/compose.yaml stay"
  fi
}

restore_deploy_files() {
  if parameterised "$root/deploy.previous/compose.yaml" && [ -f "$root/deploy.previous/deploy.sh" ]; then
    install -m 0644 "$root/deploy.previous/compose.yaml" "$root/compose.yaml.next"
    mv "$root/compose.yaml.next" "$root/compose.yaml"
    install -m 0700 "$root/deploy.previous/deploy.sh" "$root/deploy.sh.next"
    mv "$root/deploy.sh.next" "$root/deploy.sh"
    say "put back the deploy.sh and compose.yaml of the previous version"
  fi
}

go_back() {
  local dir=$1 commit=$2 previous=$3 why=$4 image
  record_set "$dir" step rollback
  say "going back to ${previous:-the previous version}: $why"
  for image in "$project-hub" "$project-brain"; do
    docker_cli image inspect "$image:previous" > /dev/null 2>&1 || {
      finish "$dir" failed "$why There are no previous images to go back to, so nothing was rolled back."
      return 0
    }
  done
  compose stop brain hub || true
  local before after database
  before=$(record_get "$dir" backup_level)
  after=$(database_level "$project-hub:previous" "$dir" read || true)
  if [ -n "$before" ] && [ "$before" != none ] && { [ -z "$after" ] || [ "$after" = none ] || [ "$after" -gt "$before" ]; }; then
    if restore_database "$project-hub:previous" "$dir"; then
      database="The database was restored from the backup taken just before the switch (migration $before), because the new hub had left it at ${after:-an unreadable state}; the replaced files are kept in $dir/replaced."
    else
      database="The database could not be restored from $dir/hub.sqlite."
    fi
  else
    database="The database was kept as it was, since the new hub added no migration to it."
  fi
  say "$database"
  for image in "$project-hub" "$project-brain"; do
    docker_cli tag "$image:previous" "$image:current"
  done
  if [ -d "$root/src.previous" ]; then
    remove_tree "$root/src.failed"
    mv "$root/src" "$root/src.failed"
    mv "$root/src.previous" "$root/src"
    remove_tree "$root/src.failed"
  fi
  restore_deploy_files
  if start_services "$previous"; then
    finish "$dir" rolled-back "$why The previous version ${previous:+($previous) }was started again and answers its health check, and the brain is linked. $database"
  else
    finish "$dir" unrecovered "$why Going back did not help: the previous version ${previous:+($previous) }does not answer its health check with its brain linked. $database"
  fi
}

release() {
  local dir=$1 commit=$2 previous level image
  previous=$(revision_of "$root/src")
  record_set "$dir" previous "$previous"
  record_set "$dir" step fetch
  if ! fetch_source "$commit" "$root/src.next"; then
    remove_tree "$root/src.next"
    finish "$dir" unchanged "The source of $commit could not be fetched; the running version was not touched."
    return 0
  fi
  record_set "$dir" step build
  if ! build_images "$root/src.next" "$commit" >> "$dir/build.log" 2>&1; then
    tail -n 30 "$dir/build.log" >&2 || true
    remove_tree "$root/src.next"
    finish "$dir" unchanged "The images of $commit could not be built (see $dir/build.log); the running version was not touched."
    return 0
  fi
  say "built the images of $commit"
  record_set "$dir" step backup
  say "stopping $project-hub and $project-brain to back up the hub's database"
  compose stop brain hub || true
  if docker_cli image inspect "$project-hub:current" > /dev/null 2>&1; then
    image="$project-hub:current"
  else
    image="$project-hub:$commit"
  fi
  if ! docker_cli volume inspect "$project-hub-data" > /dev/null 2>&1; then
    level=none
  elif ! level=$(database_level "$image" "$dir" backup); then
    say "the database could not be backed up; starting the running version again"
    start_running
    remove_tree "$root/src.next"
    finish "$dir" unchanged "The hub's database could not be backed up, so nothing was switched; the running version was started again."
    return 0
  fi
  [ ! -f "$dir/hub.sqlite" ] || chmod 0600 "$dir/hub.sqlite"
  record_set "$dir" backup_level "$level"
  say "backed up the hub's database at migration $level to $dir/hub.sqlite"
  record_set "$dir" step switch
  for image in "$project-hub" "$project-brain"; do
    own_name "$image"
    if docker_cli image inspect "$image:current" > /dev/null 2>&1; then
      docker_cli tag "$image:current" "$image:previous"
    fi
    docker_cli tag "$image:$commit" "$image:current"
  done
  if [ -d "$root/src" ]; then
    remove_tree "$root/src.previous"
    mv "$root/src" "$root/src.previous"
  fi
  mv "$root/src.next" "$root/src"
  install_deploy_files "$root/src"
  say "starting $project-hub and $project-brain at $commit"
  record_set "$dir" step health
  if start_services "$commit"; then
    finish "$dir" succeeded "The hub at $commit answers its health check on 127.0.0.1:$hub_port and the brain is linked to it. The hub's database was backed up at migration $level before the switch."
    return 0
  fi
  go_back "$dir" "$commit" "$previous" "The new version $commit did not come up: its hub did not answer its health check with its brain linked."
}

run_release() {
  local dir=$1
  own_path "$dir"
  record_set "$dir" pid "$$"
  trap stopped_release EXIT
  release_dir=$dir
  set +e
  release "$dir" "$(record_get "$dir" commit)"
  set -e
  prune || true
}

stopped_release() {
  local dir=${release_dir:-}
  [ -n "$dir" ] || return 0
  [ "$(record_get "$dir" state)" = running ] || return 0
  case "$(record_get "$dir" step)" in
    fetch | build | backup) finish "$dir" unchanged "The release script stopped unexpectedly at step $(record_get "$dir" step), before anything was switched; see $dir/log." ;;
    *) finish "$dir" unrecovered "The release script stopped unexpectedly at step $(record_get "$dir" step); see $dir/log." ;;
  esac
}

new_record() {
  local dir=$1 id=$2 commit=$3
  mkdir -p "$root/releases"
  own_path "$dir"
  mkdir "$dir"
  chmod 0700 "$dir"
  : > "$dir/state"
  record_set "$dir" id "$id"
  record_set "$dir" commit "$commit"
  record_set "$dir" started "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record_set "$dir" step start
  record_set "$dir" state running
}

step_release() {
  [ "$#" -eq 1 ] || fail "release takes a commit"
  valid_commit "$1"
  local busy dir
  busy=$(running_release)
  [ -z "$busy" ] || fail "release $busy is still running"
  dir="$root/releases/manual-$(date -u +%Y%m%d%H%M%S)-${1:0:12}"
  new_record "$dir" "$(basename -- "$dir")" "$1"
  install -m 0700 "$script" "$dir/deploy.sh"
  say "releasing $1 in the foreground; the record is $dir"
  SUPERAGENT2_ROOT=$root bash "$dir/deploy.sh" run-release "$dir" 2>&1 | tee "$dir/log" >&2
  say "result: $(record_get "$dir" state): $(record_get "$dir" reason)"
  [ "$(record_get "$dir" state)" = succeeded ]
}

step_rollback() {
  [ -d "$root/src.previous" ] || fail "there is no $root/src.previous to go back to"
  local current dir found=
  current=$(revision_of "$root/src")
  for dir in $(ls -1td "$root"/releases/* 2> /dev/null || true); do
    if [ "$(record_get "$dir" commit)" = "$current" ] && [ "$(record_get "$dir" state)" = succeeded ]; then
      found=$dir
      break
    fi
  done
  dir="$root/releases/manual-$(date -u +%Y%m%d%H%M%S)-rollback"
  new_record "$dir" "$(basename -- "$dir")" "$current"
  if [ -n "$found" ] && [ -s "$found/hub.sqlite" ]; then
    cp -p "$found/hub.sqlite" "$dir/hub.sqlite"
    record_set "$dir" backup_level "$(record_get "$found" backup_level)"
    say "the backup taken before $current was switched in is $found/hub.sqlite"
  else
    say "no backup taken before $current was switched in was found; the database is kept as it is"
  fi
  record_set "$dir" pid "$$"
  go_back "$dir" "$current" "$(revision_of "$root/src.previous")" "Went back by hand from $current."
  say "result: $(record_get "$dir" state): $(record_get "$dir" reason)"
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
  say "about to prepare $root/secrets: values copied by name from $old/secrets"
  umask 077
  mkdir -p "$root/secrets"
  chmod 0700 "$root/secrets"
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
  chmod 0600 "$root/secrets/hub.env" "$root/secrets/brain.env" "$root/secrets/tunnel.env"
  say "the brain's token to the hub is made by the hub at its first start, on volume $project-brain-link"
}

step_codex_login() {
  own_name "$project-brain-codex"
  say "about to copy the Codex login (auth.json only) from volume $old_codex_volume, mounted read-only, into volume $project-brain-codex"
  docker_cli volume inspect "$old_codex_volume" > /dev/null || fail "volume $old_codex_volume does not exist"
  compose run --rm --no-deps --name "$project-codex-login-copy" \
    --volume "$old_codex_volume:/old:ro" \
    --entrypoint bash brain -c '
      set -eu
      if [ -e /home/node/.codex/auth.json ]; then
        echo "superagent2 deploy: the brain codex volume already holds auth.json; it is kept" >&2
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
  say "about to start $project-hub and $project-brain, the hub on 127.0.0.1:$hub_port"
  mkdir -p "$root/projects"
  compose up -d hub brain
}

step_health() {
  healthy "" || fail "not healthy"
}

step_deauthorize() {
  local key="$root/secrets/ssh/nas_ed25519.pub"
  local keys="$HOME/.ssh/authorized_keys"
  [ -r "$key" ] || fail "no public key at $key"
  say "about to remove the hub's key from $keys"
  local body
  body=$(awk '{print $2}' "$key")
  [ -n "$body" ] || fail "$key holds no key"
  if ! grep -qF "$body" "$keys" 2> /dev/null; then
    say "the hub's key is not authorized; $root/secrets/ssh is no longer used and can be deleted"
    return 0
  fi
  mkdir -p "$root/backups"
  cp -p "$keys" "$root/backups/authorized_keys.$(date +%Y%m%d%H%M%S)"
  grep -vF "$body" "$keys" > "$keys.superagent2" || true
  chmod 0600 "$keys.superagent2"
  mv "$keys.superagent2" "$keys"
  say "removed the hub's key; $root/secrets/ssh is no longer used and can be deleted"
}

step_stop() {
  say "about to stop $project-hub and $project-brain, keeping their containers, volumes and images"
  compose stop brain hub
}

step_status() {
  compose --profile tunnel ps -a
  say "running: $(revision_of "$root/src") (before it: $(revision_of "$root/src.previous"))"
  local dir
  for dir in $(ls -1td "$root"/releases/* 2> /dev/null | head -n "$releases_kept" || true); do
    say "release $(basename -- "$dir"): $(record_get "$dir" state) at step $(record_get "$dir" step): $(record_get "$dir" reason)"
  done
}

step_takeover() {
  [ "$instance" = superagent2 ] || fail "only the superagent2 folder takes over the host name"
  [ -s "$root/secrets/tunnel.env" ] || fail "$root/secrets/tunnel.env is missing"
  grep -q '^TUNNEL_TOKEN=.' "$root/secrets/tunnel.env" || fail "$root/secrets/tunnel.env holds no TUNNEL_TOKEN"
  step_up
  step_health
  say "about to stop the first Super-agent's superagent-tunnel, superagent-brain and superagent-hub (kept with their volumes, not removed), then start superagent2-tunnel"
  docker_cli stop superagent-tunnel superagent-brain superagent-hub
  compose --profile tunnel up -d tunnel
  say "superagent2-tunnel is started; the host name now reaches superagent2-hub"
}

step_giveback() {
  [ "$instance" = superagent2 ] || fail "only the superagent2 folder gives the host name back"
  say "about to stop superagent2-tunnel, superagent2-brain and superagent2-hub, then start the first Super-agent's superagent-hub, superagent-brain and superagent-tunnel again"
  compose --profile tunnel stop tunnel brain hub
  docker_cli start superagent-hub superagent-brain superagent-tunnel
  say "the first Super-agent is running again"
}

usage() {
  cat >&2 << 'USAGE'
usage: bash /share/Container/<instance>/deploy.sh <step> [arguments]
a release, run on the NAS by a person or by a worker over their own sign-in:
  release <commit>         fetch, build while the old version runs, back up the database, switch, check, and go back on failure
  rollback                 go back to the previous version, restoring the database backed up before the current one
  status                   the containers, the running commit and the latest releases
first deployment and upkeep:
  secrets, codex-login, up, health, stop, takeover, giveback
  deauthorize              remove the key an earlier version let the hub sign in to the NAS host with
USAGE
  exit 2
}

main() {
  local step=${1:-}
  [ "$#" -gt 0 ] && shift
  case "$step" in
    release) step_release "$@" ;;
    rollback) step_rollback ;;
    status) step_status ;;
    run-release) run_release "$@" ;;
    secrets) step_secrets ;;
    codex-login) step_codex_login ;;
    up) step_up ;;
    health) step_health ;;
    deauthorize) step_deauthorize ;;
    stop) step_stop ;;
    takeover) step_takeover ;;
    giveback) step_giveback ;;
    *) usage ;;
  esac
}

main "$@"
