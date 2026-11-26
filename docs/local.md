# Local installation checklist

1. Install Node.js 24 with Corepack, Git and GitHub CLI on the computer.
2. Sign in to `gh` for the GitHub accounts you want to use, and install and sign in to at least one brain and worker provider such as Codex or Claude Code.
3. From the Super Agent checkout, run `corepack pnpm install --frozen-lockfile` and `corepack pnpm build`.
4. Run `corepack pnpm local` to create `local.env` in `%LOCALAPPDATA%\super-agent2` on Windows or `~/.super-agent2` elsewhere, or in `SUPERAGENT2_HOME` if set.
5. Set `PROJECTS_DIR` in `local.env` to an existing absolute folder for your repositories and keep the state folder outside it.
6. Run `corepack pnpm local` again and open the printed address, normally `http://127.0.0.1:18180/`.
7. Check that `local` appears online and the runner lists the installed provider programs.
8. Press Ctrl+C to stop the installation, and use the same state folder to resume it.

Set `PORT` to change the listening port or `TIME_ZONE` to override the computer's time zone.
Use existing setting names in `local.env` to configure integrations or provider programs, such as `BRAIN_PROVIDERS` or `RUNNER_MODELS_CODEX`.
On Windows the brain's `run_command` tool runs in Windows PowerShell.

## Using Cloudflare Access

Set `ACCESS_TEAM`, `ACCESS_AUD` and `OWNER_EMAIL` for the owner application and `ACCESS_RUNNER_AUD` for a separate runner application if one is configured.
Point your tunnel at the local listening address and set `SUPERAGENT2_HUB` to the HTTPS Access URL.
Set `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` to the service token for the local runner so its connection goes through the configured Access application.
For additional runners, use the usual Access service and runner tokens.

See the [front-door design](design.md#front-door) for the admission rules.
