# Deployment on the NAS

Super-agent2 runs on the NAS as the Compose project `superagent2`: `superagent2-hub`, `superagent2-brain`, and
`superagent2-tunnel`, which starts only with the Compose profile `tunnel`. Everything is driven by
`/share/Container/superagent2/deploy.sh` with `/share/Container/superagent2/compose.yaml`, run on the NAS as `novanxu`
by a person, or by a worker over its own sign-in to the NAS. The hub has no way into the NAS host: no target of
`run_command` runs there, and the hub's container holds no key to sign in with.

The same two files serve any instance: the folder the script lives in names it. `/share/Container/superagent2` is the
live system; `/share/Container/superagent2-<name>` is another instance (a rehearsal) whose Compose project, containers,
volumes, images and network are all named `superagent2-<name>…`. An instance other than the live one needs
`instance.env` in its folder with `HUB_PORT=<port>`; the live one defaults to 18180. Every path the script deletes or
moves is checked to be inside its own folder and every image it tags or removes to carry its own name.

## Where things live

| What | Where |
| --- | --- |
| Deploy script and Compose file | `/share/Container/superagent2/deploy.sh` and `compose.yaml`, installed from `deploy/` of each release; the ones before it in `deploy.previous/` |
| Source of the running version | `/share/Container/superagent2/src` (its commit in `src/.revision`); the one before it in `src.previous` |
| Releases | `/share/Container/superagent2/releases/<id>/`: `state` (what the release did, line by line), `log`, `build.log`, `hub.sqlite` (the database backed up just before the switch) and, after a rollback that restored it, `replaced/` (the database files the failed version left). The newest five are kept. `<id>` is `manual-<time>-<commit>`; `d<deployment>-<commit>` are releases an earlier hub started |
| Uploaded archives | `/share/Container/superagent2/incoming/<commit>.tar`, used instead of GitHub when present |
| Secrets | `/share/Container/superagent2/secrets`: `hub.env`, `brain.env`, `tunnel.env` |
| Project folders | `/share/Container/superagent2/projects`, mounted at the same path in the hub; the only place the lock lets a delete run unasked |
| Docker client settings | `/share/Container/superagent2/.docker` |
| Copies of `authorized_keys` taken before a change | `/share/Container/superagent2/backups` |
| Hub database | volume `superagent2-hub-data` (`hub.sqlite`) |
| Brain's token to the hub | volume `superagent2-brain-link`, made by the hub at its first start |
| Hub's home folder (`known_hosts`, `gh` and `git` settings) | volume `superagent2-hub-home` |
| Codex, Claude Code and `dsh` logins and sessions | volumes `superagent2-brain-codex`, `superagent2-brain-claude`, `superagent2-brain-dsh` |
| Brain's working folder | volume `superagent2-brain-workspace` |
| Images | `superagent2-hub` and `superagent2-brain`, tagged `current`, `previous` and the commit; commit tags other than the running and the previous version are removed after each release |
| The hub on the NAS itself | `http://127.0.0.1:18180` (only `/health` answers without the front door; it names the running commit) |

Docker is `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker`. To look at the project by hand:

```sh
bash /share/Container/superagent2/deploy.sh status
```

It lists the containers, the running and previous commits and the latest releases with how each ended.

## How Super-agent2 is deployed

The hub does not deploy Super-agent2. The repository has no `.superagent2/deployment.json`, and `deploy_repository`
refuses the hub's own repository. When a ticket of Super-agent2 merges, the brain is told that the new version is merged
and waits to be deployed, and it tells the owner. The owner deploys it on the NAS, or files work for a worker to deploy
it; the worker signs in to the NAS with the access of its own machine, not through the hub. Once it is deployed, the
owner tells the brain, which records it with `report_deployment`, so tickets arranged after that deployment begin.

On the NAS, with the full commit id:

```sh
bash /share/Container/superagent2/deploy.sh release <commit>
```

It runs in the foreground, prints each step and ends with its result. It needs neither the hub nor the brain:

1. fetches the commit from GitHub with `GITHUB_TOKEN_NOVAN_XU` from `secrets/hub.env` (or unpacks
   `incoming/<commit>.tar`, if one was uploaded) into `src.next`;
2. builds both images, tagged with the commit, while the old version keeps running;
3. stops hub and brain, and backs up the hub's database into the release's folder with SQLite's `VACUUM INTO`;
4. switches: the old images become `previous`, the new ones `current`, `src` becomes `src.previous`, and the release's
   `deploy.sh` and `compose.yaml` are installed;
5. starts the hub and waits until `/health` answers with the new commit, then starts the brain and waits until it is
   linked;
6. on failure goes back: stops both, restores the database from the backup when the new hub left it at a higher
   migration than the previous hub knows (the replaced files are kept), puts back the previous images, source and deploy
   files, starts them and checks them again.

To go back to the version before the running one:

```sh
bash /share/Container/superagent2/deploy.sh rollback
```

It finds the release that switched the running version in, restores the database backed up then if the running hub
added migrations since, and starts the previous images and source. To only start or stop what is there:
`deploy.sh up`, `deploy.sh stop`, and `deploy.sh health` to check.

To release a commit that is not on GitHub, upload its archive first. From a clone, with `C` the commit:

```sh
git archive --format=tar -o "superagent2-$C.tar" "$C"
ssh novan-nas-maintenance "cat > /share/Container/superagent2/incoming/$C.tar" < "superagent2-$C.tar"
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh release $C"
```

## Updating an instance that let the hub sign in to the NAS host

Versions before #60 gave the hub a key to the NAS host (`secrets/ssh/nas_ed25519`, mounted at `/run/superagent2/ssh`)
and authorized it in `novanxu`'s `~/.ssh/authorized_keys`. Release the first version without it by hand, as above. The
release installs its own `deploy.sh` and `compose.yaml`, so the new hub starts without the key's mount, without
`NAS_SSH_DESTINATION`, `NAS_SSH_IDENTITY` and `SUPERAGENT2_INSTANCE`, and without the `host.docker.internal` host entry.
None of these was in an env file under `secrets`, so no env file needs editing; a hub that is given them anyway ignores
them. Then, on the NAS as `novanxu`:

```sh
bash /share/Container/superagent2/deploy.sh deauthorize
rm -rf /share/Container/superagent2/secrets/ssh
docker exec superagent2-hub ssh-keygen -R host.docker.internal -f /home/node/.ssh/known_hosts
```

`deauthorize` removes the hub's key from `authorized_keys` if it is still there, with a copy of the file before in
`backups/`, and says so either way; on the live system the key was already removed by hand. Run it before deleting
`secrets/ssh`, since it reads the public key there. The last line drops the NAS host's key from the hub's `known_hosts`
on volume `superagent2-hub-home`; it is harmless to leave. To check that the hub holds nothing to sign in with:

```sh
docker exec superagent2-hub sh -c 'ls /run/superagent2/ssh; env | grep -c NAS_SSH'
```

It answers that there is no such folder, and `0`.

## Runners

A runner moves to the version its hub runs by itself. The hub's image carries its commit (`SUPERAGENT2_REVISION`, set
by the release's build), and the hub announces it in its welcome to every runner. A runner at another version fetches
the hub's release from `GET /runner/release` (the hub streams GitHub's tarball of its own commit; the runner passes the
front door as for its link), unpacks it into `~/.superagent2/versions/<commit>`, runs `pnpm install --frozen-lockfile`
and builds the runner there, and checks that the new runner reports the version asked for. Meanwhile it keeps working.
It switches only when no worker and no command runs on it: it writes `~/.superagent2/version.json` and exits with code
75, and its supervisor (Windows) or launch agent (macOS) starts `~/.superagent2/start.mjs`, which starts the version
named there. The new runner reconnects, the hub resumes whatever it holds, and its first welcome confirms it; a version
that stops three times before reaching the hub is replaced by the previous one again and never retried. An update that
fails leaves the running runner as it is and is tried again after an hour. Only a runner started by its supervisor or
launch agent updates itself; one started by hand with `run` says that an update is available.

A runner installed before this scheme starts `main.js` of its checkout directly; run `install` once from a checkout that
contains #18 to move it to `start.mjs`.

## Take over the host name

```sh
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh takeover"
```

It starts hub and brain and checks them, then runs

```sh
docker stop superagent-tunnel superagent-brain superagent-hub
docker compose -p superagent2 -f /share/Container/superagent2/compose.yaml --profile tunnel up -d tunnel
```

The old containers are stopped, not removed, and their volumes are untouched; their restart policy is `unless-stopped`,
so they stay stopped across a restart of the NAS. The tunnel's configuration at Cloudflare routes the host name to
`http://hub:8080`, which on the `superagent2_default` network is the new hub. `superagent-converter` and
`superagent-nas-access` are left running. Only the live folder takes over or gives back.

## Go back to the first Super-agent

```sh
ssh novan-nas-maintenance "bash /share/Container/superagent2/deploy.sh giveback"
```

It stops `superagent2-tunnel`, `superagent2-brain` and `superagent2-hub` and starts `superagent-hub`,
`superagent-brain` and `superagent-tunnel` again.

Both brains use the same ChatGPT login. If the new brain refreshed it while it ran, the old brain's copy may be signed
out after going back, and `codex login` has to be run again in `superagent-brain`.

## Setting up an instance from nothing

```sh
bash /share/Container/superagent2/deploy.sh secrets
bash /share/Container/superagent2/deploy.sh codex-login
bash /share/Container/superagent2/deploy.sh release <commit>
```

with `deploy.sh` and `compose.yaml` put in the folder first.

- `secrets` copies, by name and file to file, `ACCESS_TEAM`, `ACCESS_AUD`, `OWNER_EMAIL`, `GITHUB_TOKEN_NOVAN_XU`,
  `GITHUB_TOKEN_NUOFAN_ISLAND`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_API_TOKEN`, `CLOUDFLARE_API_TOKEN`,
  `WOODPECKER_SERVER`, `WOODPECKER_TOKEN`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` into `hub.env`,
  `BRAIN_CLAUDE_OAUTH_TOKEN` into `brain.env` and `TUNNEL_TOKEN` into `tunnel.env`, from
  `/share/Container/superagent/secrets`. A file that already exists is kept; delete it to copy it again.
- `codex-login` copies only `auth.json` from the first Super-agent's volume `superagent-brain-codex-home`, mounted
  read-only, and keeps an `auth.json` already in the instance's codex volume.

Nothing is authorized for the hub on the NAS host: it gets no key and needs none.

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

## Woodpecker from the hub

`WOODPECKER_SERVER` is `https://novanstorage.tail62dd17.ts.net:9443`, the NAS's own Tailscale name. On the NAS host that
name resolves through Tailscale's resolver to the NAS's Tailscale address, `100.72.209.101`, where port 9443 is served.
Inside a container the name is resolved by public DNS instead, which answers with Tailscale's public relay addresses,
and a request to those times out. `deploy/compose.yaml` therefore gives the hub an extra host entry,
`novanstorage.tail62dd17.ts.net:100.72.209.101`: the container keeps the name, so TLS still checks the right
certificate, and reaches the address through the host. If the NAS's Tailscale address ever changes, change the entry.

To check it, on the NAS:

```sh
docker exec superagent2-hub sh -c 'curl -sS -m 10 "$WOODPECKER_SERVER/version"'
```

## CI

Woodpecker checks this repository with `.woodpecker/check-macos.yaml` and `.woodpecker/check-windows.yaml`, on the Mac
mini's and the PC's agents. Both run `pnpm check` on every pull request's head, on every push to `main`, and by hand.
Each downloads the Node version in `.node-version` from nodejs.org, checks it against the release's `SHASUMS256.txt`,
installs the pnpm version in `package.json`'s `packageManager` with that Node's npm, all inside the workflow's own
folder, and changes nothing on the agent. GitHub shows their statuses as `ci/woodpecker/pr/check-macos` and
`ci/woodpecker/pr/check-windows` on a pull request, and as `ci/woodpecker/push/...` on `main`.

The repository is activated on the server under the owner's account; activation made the GitHub webhook. Its settings
are the server's defaults: pull requests allowed, approval only for forks, a 60-minute limit, and a running pipeline
cancelled by a newer push or pull request commit.
