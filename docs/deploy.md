# Deployment on the NAS

Super-agent2 runs on the NAS as the Compose project `superagent2`: `superagent2-hub`, `superagent2-brain`, and
`superagent2-tunnel`, which starts only with the Compose profile `tunnel`. Everything is driven by
`/share/Container/superagent2/deploy.sh` with `/share/Container/superagent2/compose.yaml`, run on the NAS as `novanxu`
by a person, or by a worker over its own machine's sign-in to the NAS. The hub has no way into the NAS host: the brain's
`run_command` runs only in the hub's container, and the container holds no key to sign in with.

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
| The owner's attachments | volume `superagent2-brain-link`, folder `attachments` (`HUB_ATTACHMENTS_DIR` for the hub, `BRAIN_ATTACHMENTS_DIR` for the brain, both `/var/lib/superagent2/link/attachments`); kept, never pruned, and not part of a release's database backup |
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

Super-agent2 is deployed like any repository: by a worker, through a task ticket the brain arranges after the chain
that changes it, started with that chain's 开始. Its recipe is `.superagent2/deployment.json`:

- `target` is `mac-mini`, the owner's Mac mini, whose own SSH access reaches the NAS as `novan-nas-maintenance`. The hub
  runs the ticket only on the runner of that name, and the runner refuses to deploy anywhere else. If the machine that
  should deploy has another name, change `target` (through a code ticket) or name the runner `mac-mini`.
- `deploy` runs `deploy.sh release` of the checkout's commit on the NAS over that SSH alias; `health` runs
  `deploy.sh health`; `rollback` runs `deploy.sh rollback`.

While the release runs, the hub and the brain stop and start again under the ticket. The runner's link drops and comes
back; the worker keeps running on the Mac mini, its events are kept on disk and synced to the new hub, its hand-back is
delivered there, and only once no worker runs does the runner move to the new hub's version. A runner never switches to a
version the hub no longer announces, so if the release goes back, the runner stays where it is. A worker that finds the
new version does not come up hands back failed, and the brain guides it like any failure.

By hand, on the NAS, with the full commit id:

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

## Updating the live system to the version with task tickets

This version is released by hand once, as above, from the running version, which still deploys nothing itself:

- Migration 24 turns writing tickets into task tickets, drops the tables of the hub's own deployments (the commands they
  ran stay in the command history), and withdraws any deployment command still held for confirmation, with the reason
  that deployments are now done by tickets.
- After the release, every runner moves to the new version by itself once its workers are idle. A runner of the
  previous version still holding a writing worker finishes it under the old version first.
- For Super-agent2 to deploy itself, the Mac mini's runner must be named `mac-mini` (or `target` changed), and the account it runs
  as must reach the NAS with `ssh novan-nas-maintenance` without a prompt.
- `secrets/brain.env` and `secrets/hub.env` need no change. `NAS_SSH_*`, `HUB_CREDENTIAL_PATHS` and any deployment
  settings an older hub was given are ignored.

## Updating the live system to the version without an open route

This version (#78) removes `POST /runner/enroll`; the hub now answers nothing without a signed Access assertion except
`/health`, which through the host name is behind the owner's sign-in like everything else. It is released like any
version. Then:

- Migration 28 drops `install_codes` (any unused install code is gone with it) and adds four columns to `machines`: the
  machine's system and hub address, when its service token runs out, and when the owner was told so. A machine whose
  service token the hub made before this version (`access_token_id` set) is dated one year after it was added, which is
  the lifetime Cloudflare gave a token created without a duration; one added with `--access-client-id` is not dated.
- The hub keeps admitting runners through the host's own application until `ACCESS_RUNNER_AUD` is set, so the update
  alone changes nothing for a runner that already connects. Set up Cloudflare as in the next section, then put the new
  application's audience tag in `secrets/hub.env` as `ACCESS_RUNNER_AUD=<tag>` and recreate the hub with
  `bash /share/Container/superagent2/deploy.sh up`. Runners cannot connect between saving the application and
  recreating the hub, so do the two together; each runner reconnects by itself.
- A service token the hub made before this version has no tag, so the runner application's policy refuses it. For each
  service token named `superagent2-runner-<name>` in Zero Trust › Access controls › Service credentials › Service Tokens,
  open it, add the tag `superagent2` = `runner` and save; Cloudflare's documentation says editing only the tags neither
  rotates the secret nor changes the expiry. Or revoke the machine in 设置 and add it again, which also gives it a token
  that does not expire.
- `secrets/brain.env` and the rest of `secrets/hub.env` need no change.

## Cloudflare Access

The host name has two Access applications. Nothing in them changes when a machine is added or revoked.

| Application | Covers | Policy | Audience tag in `secrets/hub.env` |
| --- | --- | --- | --- |
| The host's own (exists) | The host name, empty path | Allow: the owner's email, through Google | `ACCESS_AUD` |
| Super-agent2 runners (new) | The host name, path `runner` | Service Auth: service token tag `superagent2` = `runner` | `ACCESS_RUNNER_AUD` |

Cloudflare gives the more specific path precedence, and a path covers the paths below it, so `/runner/link`,
`/runner/release` and `/runner/install` are decided by the runner application alone: a service token never reaches the
owner's pages or API at Cloudflare, and the owner's sign-in never reaches the runner paths. The hub checks the same
thing again: it takes an assertion for `ACCESS_RUNNER_AUD` only on `/runner/` and only as a service token, and one for
`ACCESS_AUD` only elsewhere; and on `/runner/` it also needs the machine's own runner token, bound to that service token.

Steps, once, in the Cloudflare dashboard (Zero Trust):

1. **The host's own application.** Access controls › Applications › the application for the hub's host name › Policies.
   Keep only the owner's Allow policy. If it has a policy whose action is Service Auth (added earlier for runners),
   remove that policy from this application and save.
2. **The runner application.** Access controls › Applications › Add an application › Self-hosted. Name it
   `Super-agent2 runners`. Under the public hostname, enter the hub's host name (the same subdomain and domain as the
   host's own application) and the path `runner`. Leave the identity providers and session settings as they come;
   no person signs in here.
3. **Its policy.** Add one policy, named `Runner service tokens`, with the action **Service Auth** and one Include rule:
   selector **Service Token Tag**, tag key `superagent2`, tag value `runner`. Add no other rule and no other policy. Save
   the application. If the account does not offer the Service Token Tag selector, use **Any Access Service Token**
   instead; that also needs no change per machine, but lets every service token of the account through to the runner
   paths, where the hub still refuses any that is not a machine's.
4. **Its audience tag.** Access controls › Applications › Edit on the new application › Additional settings: copy its
   Application Audience (AUD) Tag. Put it in `/share/Container/superagent2/secrets/hub.env` as `ACCESS_RUNNER_AUD=<tag>`
   and run `bash /share/Container/superagent2/deploy.sh up`. The hub refuses to start if it equals `ACCESS_AUD`.
5. **The hub's API token.** `CLOUDFLARE_ACCESS_API_TOKEN` must be an API token of the account `CLOUDFLARE_ACCOUNT_ID`
   with the one permission Account › **Access: Service Tokens** › **Edit** (Cloudflare's documentation calls it
   "Access: Service Tokens Write"), for that account only. The hub uses it for two calls and nothing else:
   `POST /accounts/<id>/access/service_tokens` with the name `superagent2-runner-<machine>`, the duration `forever`
   and the tag `superagent2` = `runner` when 添加机器 is pressed, and `DELETE /accounts/<id>/access/service_tokens/<token id>`
   when a machine is revoked. It needs no permission on applications or policies.
6. **The old Bypass application, if it was ever made.** The versions before #78 asked for an application for the path
   `runner/enroll` with a Bypass policy; on the live system it was never made. If it exists: Access controls ›
   Applications, find the application whose public hostname is the hub's host name with the path `runner/enroll`
   (usually named after enrolment), open it and delete it. Delete any policy that was made only for it under Access
   controls › Policies as well. Until it is deleted it would let anyone reach `/runner/enroll`, which the hub now
   refuses with 403.

To check, from a machine with no credentials: `curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/runner/install`
must not print 200 (Cloudflare refuses it before the hub sees it), and the same address opened in the owner's signed-in
browser must not show a script either. A machine added after the set-up shows as online in 设置 once its install line has
run.

Not checked against the real Cloudflare: the hub's two API calls (in particular that `duration: "forever"` and `tags`
are accepted and what the answer then says about expiry), that a path application's assertion carries that
application's own audience tag, that the Service Token Tag selector is offered on this account, and what Cloudflare
answers to a refused request (a redirect to the sign-in or a 403). All of this comes from Cloudflare's documentation and
is exercised only against a fake in the tests and in `tools/page-dev`; if adding a machine fails, 设置 shows Cloudflare's
own reason.

## Service tokens and their lifetime

A service token created through the API without a duration lasts one year (`8760h`, Cloudflare's default); when it runs
out, Cloudflare refuses the machine, its runner keeps trying, and 设置 shows the machine offline with nothing else to say
why. The hub therefore asks for `duration: "forever"`, which Cloudflare documents as a token that does not expire. If
Cloudflare answers with an expiry anyway, the hub keeps it. A machine whose token has an expiry shows 令牌 … 到期 on its
card in 设置, in red within thirty days; thirty days before, the hub writes a notice into the latest conversation for
the owner and tells the brain, once per token. The fix is to revoke the machine and add it again (a new install line on
that machine), or to refresh the token in Cloudflare's dashboard, after which the card still shows the old date.

## Runners

A runner moves to the version its hub runs by itself. The hub's image carries its commit (`SUPERAGENT2_REVISION`, set
by the release's build), and the hub announces it in its welcome to every runner. A runner at another version fetches
the hub's release from `GET /runner/release` (the hub streams GitHub's tarball of its own commit; the runner passes the
front door as for its link), unpacks it into `~/.superagent2/versions/<commit>`, runs `pnpm install --frozen-lockfile`
and builds the runner there, and checks that the new runner reports the version asked for. Meanwhile it keeps working.
It switches only when no worker runs on it, and only to the version the hub announces at that moment: it writes `~/.superagent2/version.json` and exits with code
75, and its supervisor (Windows) or launch agent (macOS) starts `~/.superagent2/start.mjs`, which starts the version
named there. The new runner reconnects, the hub resumes whatever it holds, and its first welcome confirms it; a version
that stops three times before reaching the hub is replaced by the previous one again and never retried. An update that
fails leaves the running runner as it is and is tried again after an hour. Only a runner started by its supervisor or
launch agent updates itself; one started by hand with `run` says that an update is available.

### Storage folders

Edit each machine's projects and artifacts paths in Settings → Machines. The initial paths for the owner's machines
are:

| Machine | Projects folder | Artifacts folder |
| --- | --- | --- |
| `pc` | `C:\01_Projects` | `M:\Zdir\Super-agent` |
| `mac-mini` | `/Users/novan/Novan/Code Projects` | `/Volumes/NAS/Zdir/Super-agent` |

Paths are local to the runner. The projects folder must already exist. The shared artifacts folder must be mounted
and writable by the account that runs the runner. A Windows drive mapping must be available to that account.
The machine card displays the folders in use as placeholders and reports path and mount problems beneath the affected
field. Changes saved while a runner is offline are sent on reconnect. The hub does not need the share mounted.

To use `PROJECTS_DIR` or `ARTIFACTS_DIR` from `~/.superagent2/runner.env`, clear the respective setting on the machine
card. Windows paths must include a drive and root or a UNC server and share. Without a projects folder, the runner
uses its state directory for clones, worktrees, and scratch folders. Already allocated worktrees and scratch folders
stay in place when settings change. Workers that start afterwards get the newly selected artifacts path.

When a share fails or times out at session start, the ticket records the local path under `~/.superagent2/artifacts`.
Files written there stay local. Once the share returns, subsequent sessions can write to the NAS. Ending a ticket
leaves its artifacts in place.

### Adding or revoking a machine by hand on the NAS

添加机器 in 设置 needs the owner's sign-in. The same thing can be done on the NAS, as `novanxu`, by the hub's own command
line inside its container; it is a local command and no route of the hub reaches it. It uses the hub's environment
(`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_API_TOKEN`, `SUPERAGENT2_REVISION`, `HUB_SOURCE_REPOSITORY`, `HUB_DATA_DIR`)
and does exactly what the button does: it creates the machine's Access service token through the same Cloudflare call
(named `superagent2-runner-<name>`, not expiring, tagged `superagent2` = `runner`), makes its runner token, registers the
machine and prints, once, the install line for the system given. With `<host>` the hub's host name:

```sh
docker=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
$docker exec superagent2-hub node dist/machines-cli.js add pc --system windows --hub https://<host>
$docker exec superagent2-hub node dist/machines-cli.js add mac-mini --system macos --hub https://<host>
```

The line reaches the hub through Cloudflare, so it works only once Cloudflare lets the new token through to `/runner/`:
through the runner application of [Cloudflare Access](#cloudflare-access), or, before that exists and while
`ACCESS_RUNNER_AUD` is unset, through a Service Auth policy on the host's own application that admits the new token
(for example Any Access Service Token). Run the printed line once on that machine: in Windows PowerShell for `windows`,
in the terminal for `macos`. The line
holds the machine's credentials; it is printed only this once and is not kept anywhere, so copy it straight to the machine.
The running hub admits the machine at once, and it appears in 设置 as not yet connected until the line has run. When
the hub's Cloudflare settings or its version are missing, or Cloudflare refuses, the command says so, exits non-zero and
adds nothing, for the same reasons the page gives. To list and to revoke:

```sh
$docker exec superagent2-hub node dist/machines-cli.js list
$docker exec superagent2-hub node dist/machines-cli.js revoke pc
```

`revoke` refuses the machine from then on, has the running hub close its connection within a few seconds, and deletes the
service token at Cloudflare, as 撤销 does; it says so if the token could not be deleted. `add <name> --access-client-id
<id> --hub https://<host>` still adds a machine with an existing service token and prints the setup line of #9 instead.

A runner installed before this scheme starts `main.js` of its checkout directly; run `install` once from a checkout that
contains #18 to move it to `start.mjs`.

On Windows two things start the runner: the `Run` value `SuperAgent2Runner` at login, and the scheduled task
`SuperAgent2Runner`, which every 5 minutes starts the supervisor if it is not running. Both go through the task, so the
supervisor belongs to the Task Scheduler service and not to the terminal or program that ran `install` or `launch`;
closing or updating that program does not end the runner. `node ~/.superagent2/start.mjs status` prints an `Autostart:`
line that says which of the two exist. A runner installed before the task existed registers it by itself after it has
updated and reached the hub; `install` run again does the same at once. `uninstall` removes both.

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

The hub uses `gotenberg/gotenberg:9.8.0-libreoffice` for Office previews. The converter has no published port or volumes and is attached only to the internal `converter` network shared with the hub. Preview PDFs are cached under the hub data volume in `previews/`. Release and rollback start the converter before the hub.
