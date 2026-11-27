# Local installation checklist

1. Install Node.js 24 with Corepack, Git and GitHub CLI on the computer.
2. Sign in to `gh` for the GitHub accounts you want to use, and install and sign in to at least one brain and worker provider such as Codex or Claude Code.
3. From the Super Agent checkout, run `corepack pnpm install --frozen-lockfile` and `corepack pnpm build`.
4. Run `corepack pnpm local` to create `local.env` in `%LOCALAPPDATA%\super-agent2` on Windows or `~/.super-agent2` elsewhere, or in `SUPERAGENT2_HOME` if set.
5. Set `PROJECTS_DIR` in `local.env` to an existing absolute folder for your repositories and keep the state folder outside it.
6. Run `corepack pnpm local` again and open the printed address, normally `http://127.0.0.1:18180/`.
7. Check that `local` appears online and the runner lists the provider programs it finds signed in.
8. Press Ctrl+C to stop the installation, and use the same state folder to resume it.

Set `PORT` to change the listening port or `TIME_ZONE` to override the computer's time zone.
Use existing setting names in `local.env` to configure integrations or provider programs, such as `BRAIN_PROVIDERS` or `RUNNER_MODELS_CODEX`.
On Windows the brain's `run_command` tool runs in Windows PowerShell.

## Updating the local edition

For Super Agent work filed here, the brain arranges one build ticket after the last code chain for the update.
Starting that chain also authorizes the build on the `local` runner after the merge.
The runner fetches the merged commit from the installation checkout's GitHub origin and runs `corepack pnpm install --frozen-lockfile` and `corepack pnpm build` in a separate worktree.
Keep the installation checkout clean and on a commit that can fast-forward to the update.
A build failure reports the command output and leaves the running checkout intact.
After a successful build, the local edition lets current work finish before restarting.
The new process verifies the commit, advances the installation checkout by fast-forwarding, and reports the update in the ticket's topic.
Subsequent launches use the verified build under the installation state folder.
To return to a manually built checkout, stop the local edition, build the checkout, remove `local-build-active.json` from the state folder, and start `corepack pnpm local` again.

## Using Cloudflare Access

Set `ACCESS_TEAM`, `ACCESS_AUD` and `OWNER_EMAIL` for the owner application and `ACCESS_RUNNER_AUD` for a separate runner application if one is configured.
Point your tunnel at the local listening address and set `SUPERAGENT2_HUB` to the HTTPS Access URL.
Set `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` to the service token for the local runner so its connection goes through the configured Access application.
For additional runners, use the usual Access service and runner tokens.

See the [front-door design](design.md#front-door) for the admission rules.

## Remote control through the NAS

Keep the local installation in loopback mode and set up [a peer on the NAS](deploy.md#remote-control-peers).
Use matching releases on the NAS and the local computer so the NAS web app and the local API work together.
Paste the four `PEER_*` settings printed by the NAS command into the local `local.env` and restart with `corepack pnpm local`.
The local edition opens an outbound secure WebSocket and needs no tunnel, additional install or inbound port on this computer.
Open 远程控制 on the signed-in NAS page and choose the local edition when it is online.
Topics, tickets, attachments and commands opened there belong to the local installation.
Use 返回主站 to return to the NAS page.
Use the local installation's direct URL to subscribe to its push notifications.
The connection retries automatically after a network interruption or restart.
Delete the four settings and restart to turn off the outbound link.

## Sharing general preferences

On paired installations, use 跨设备共享 in 记忆 to send an owner preference to the other installation.
Review the received suggestion and press 确认 there before it takes effect.
Existing memories stay local until you edit one and select sharing.
General memories are written in Simplified Chinese, and project-specific details and credentials stay local.
Edits to a shared item offer a replacement on the other installation.
Deleting an item or clearing its share setting offers removal where the memory was confirmed and withdraws its pending suggestion where it was still waiting.
Changes made offline are delivered after reconnecting.

After discussing a general engineering principle with the local brain, review its draft in 记忆 and approve sending it to the NAS.
Review the proposal with the NAS brain in the super-agent2 project.
The [development standard](development-standard.md) is the source of truth for the final rule.

## Optional integrations

An installation can start with only `PROJECTS_DIR`.
Set the relevant variables in `local.env` and restart to enable an integration.

| Integration | Settings |
| --- | --- |
| Device transfer | `HUB_DEVICE_TRANSFER=1`. |
| Inbox | `ACCESS_INBOX_AUD` for the inbox Access application, with Cloudflare API and policy settings to manage inbox sources. |
| OAuth MCP | `ACCESS_MCP_AUD` for the Managed OAuth Access application. |
| Mail, Teams and TickTick | `HUB_APP_GATEWAY=1` and a Codex login with those apps connected. |
| Mail intake | Enabled with the app gateway when mailboxes are available, and can be disabled with `HUB_MAIL_INTAKE=0`. |
| Push | `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, plus `VAPID_SUBJECT` if needed. |
| Voice | `OPENAI_API_KEY`. |
| Office previews | `HUB_CONVERTER_URL` for a compatible converter. |
| OpenAI API costs | `OPENAI_ADMIN_KEY`. |
| Extra MCP and Agent_wring | `HUB_EXTRA_MCP_SERVERS` and each server's named token variable, with a worker server named `Agent_wring` for its light-task mode. |
| Providers | Install and sign in to the CLI for Codex, Claude Code, `dsh` or Antigravity, then restart the local brain or refresh the runner's programs. |
| Woodpecker | `WOODPECKER_SERVER` and `WOODPECKER_TOKEN`. |

Antigravity needs a CLI version with the read-only `/usage` command for sign-in detection.
Memory, schedules and ordinary file attachments are part of the local edition.
Device transfer controls sending between devices, and inbox and OAuth MCP can independently enable the transfer history.
