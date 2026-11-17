# Deployment on the NAS

Super-agent2 runs on the NAS as the Compose project `superagent2`: `superagent2-hub`, `superagent2-brain`, and
`superagent2-tunnel`, which starts only with the Compose profile `tunnel`. Everything is driven by
`/share/Container/superagent2/deploy.sh`, run on the NAS as `novanxu`. Each step says what it is about to do and touches
only `superagent2` names, except the take-over and its reverse, which stop and start the first Super-agent's three
containers by name.

## Where things live

| What | Where |
| --- | --- |
| Deploy script | `/share/Container/superagent2/deploy.sh`, refreshed from `deploy/deploy.sh` by every `source` step |
| Source of the running version | `/share/Container/superagent2/src` (its commit in `src/.revision`); the one before it in `src.previous` |
| Uploaded archives | `/share/Container/superagent2/incoming/<commit>.tar` |
| Secrets | `/share/Container/superagent2/secrets`: `hub.env`, `brain.env`, `tunnel.env`, and `ssh/nas_ed25519`, the hub's key to the NAS host |
| Project folders | `/share/Container/superagent2/projects`, mounted at the same path in the hub; the only place the lock lets a delete run unasked |
| Docker client settings | `/share/Container/superagent2/.docker` |
| Copies of `authorized_keys` taken before a change | `/share/Container/superagent2/backups` |
| Hub database | volume `superagent2-hub-data` (`hub.sqlite`) |
| Brain's token to the hub | volume `superagent2-brain-link`, made by the hub at its first start |
| Hub's home folder (`known_hosts`, `gh` and `git` settings) | volume `superagent2-hub-home` |
| Codex, Claude Code and `dsh` logins and sessions | volumes `superagent2-brain-codex`, `superagent2-brain-claude`, `superagent2-brain-dsh` |
| Brain's working folder | volume `superagent2-brain-workspace` |
| Images | `superagent2-hub` and `superagent2-brain`, tagged `current`, `previous` and the commit |
| The hub on the NAS itself | `http://127.0.0.1:18180` (only `/health` answers without the front door) |

Docker is `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker`. To look at the project by hand:

```sh
docker compose -p superagent2 -f /share/Container/superagent2/src/deploy/compose.yaml --profile tunnel ps -a
docker compose -p superagent2 -f /share/Container/superagent2/src/deploy/compose.yaml logs --tail 100 hub brain
```

## Deploy a new version

From a clone of the repository, with the commit to deploy:

```sh
C=$(git rev-parse HEAD)
git archive --format=tar -o "superagent2-$C.tar" "$C"
ssh novan-nas-maintenance "mkdir -p /share/Container/superagent2/incoming && cat > /share/Container/superagent2/incoming/$C.tar" < "superagent2-$C.tar"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh release $C"
```

`release` unpacks the archive into `src` (keeping the old one as `src.previous`), builds both images (keeping the old ones
as `previous`), starts hub and brain, and checks that the hub answers its health check and the brain is linked. If the
check fails, go back:

```sh
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh rollback"
```

The steps can also be run one at a time: `source <commit>`, `build`, `up`, `health`.

## First deployment

The first time, the deploy script is not on the NAS yet, so take it out of the uploaded archive:

```sh
ssh novan-nas-maintenance "tar -xOf /share/Container/superagent2/incoming/$C.tar deploy/deploy.sh > /share/Container/superagent2/deploy.sh"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh source $C"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh secrets"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh build"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh codex-login"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh up"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh health"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh authorize"
```

- `secrets` copies, by name and file to file, `ACCESS_TEAM`, `ACCESS_AUD`, `OWNER_EMAIL`, `GITHUB_TOKEN_NOVAN_XU`,
  `GITHUB_TOKEN_NUOFAN_ISLAND`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_API_TOKEN`, `CLOUDFLARE_API_TOKEN`,
  `WOODPECKER_SERVER`, `WOODPECKER_TOKEN`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` into `hub.env`,
  `BRAIN_CLAUDE_OAUTH_TOKEN` into `brain.env` and `TUNNEL_TOKEN` into `tunnel.env`, from
  `/share/Container/superagent/secrets`. It generates the hub's SSH key. A file that already exists is kept; delete it to
  copy it again.
- `codex-login` copies only `auth.json` from the first Super-agent's volume `superagent-brain-codex-home`, mounted
  read-only, and keeps an `auth.json` already in `superagent2-brain-codex`.
- `authorize` adds the hub's public key to `novanxu`'s own `~/.ssh/authorized_keys`, accepted only from Docker's
  internal networks, and checks that the hub can sign in. It changes no `sshd` setting and no other user. `deauthorize`
  takes the key out again.

## Take over the host name

```sh
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh takeover"
```

It starts hub and brain and checks them, then runs

```sh
docker stop superagent-tunnel superagent-brain superagent-hub
docker compose -p superagent2 -f /share/Container/superagent2/src/deploy/compose.yaml --profile tunnel up -d tunnel
```

The old containers are stopped, not removed, and their volumes are untouched; their restart policy is `unless-stopped`,
so they stay stopped across a restart of the NAS. The tunnel's configuration at Cloudflare routes the host name to
`http://hub:8080`, which on the `superagent2_default` network is the new hub. `superagent-converter` and
`superagent-nas-access` are left running.

## Go back to the first Super-agent

```sh
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh giveback"
```

It runs

```sh
docker compose -p superagent2 -f /share/Container/superagent2/src/deploy/compose.yaml --profile tunnel stop tunnel brain hub
docker start superagent-hub superagent-brain superagent-tunnel
```

Both brains use the same ChatGPT login. If the new brain refreshed it while it ran, the old brain's copy may be signed
out after going back, and `codex login` has to be run again in `superagent-brain`.

## What the owner does once by hand

- **DeepSeek for `dsh`.** The brain falls back to DeepSeek only when GPT and Claude are both unavailable, and `dsh` needs
  the DeepSeek account login made once in the brain container. On the NAS, open `dsh` in the container with
  `docker exec -it -w /home/node/workspace superagent2-brain dsh tui` and sign in to the DeepSeek account from its
  account settings. The login is kept on the volume `superagent2-brain-dsh`.
- **Codex, if its login is refused.** `docker exec -it superagent2-brain codex login --device-auth`, then follow the
  link on any device.
- **Claude, if its token stops working.** Make a new one with `claude setup-token` on a computer, put it as
  `BRAIN_CLAUDE_OAUTH_TOKEN=<token>` in `/share/Container/superagent2/secrets/brain.env` (mode 600), and recreate the
  brain with `bash /share/Container/superagent2/deploy.sh up`.
- **Notifications on the phone.** Open the host name on the phone and sign in. On an iPhone, add the page to the home
  screen (Share, then Add to Home Screen) and open it from there, since iPhone allows push only for a page on the home
  screen. Then turn on 通知 next to 等你 in 工作台 and allow notifications.

## Known gaps

- `WOODPECKER_SERVER`, as copied from the first Super-agent, is an address on the NAS's Tailscale name that the hub
  container cannot reach: a request to it times out. Reading CI from the hub needs an address the container can reach.
