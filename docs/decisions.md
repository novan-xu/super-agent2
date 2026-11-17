# Decisions

Choices that would have been the owner's, made without the owner so that work does not stop. Newest last. Each entry
says what was chosen, why, and what the other options were, so it can be reviewed and undone.

## 2026-11-17 — How the issues are built

- **Chosen:** Each issue is implemented in its own session on its own branch, opened as a pull request that closes the
  issue, checked by running `pnpm check` locally, and squash-merged before the next issue starts.
- **Why:** The owner asked for one issue at a time, merged as it is finished. Woodpecker does not check this repository
  until #14, so until then the local check is the only one there is.
- **Other options:** Wait for #14 before merging anything; build several issues in parallel.

## 2026-11-17 — Order of the first milestone

- **Chosen:** #1, #2, #3, #4, #22, #5, #6, #7, #8.
- **Why:** #22 was filed after the others but #6 and #7 depend on it, and #5 has the brain speak Chinese.
- **Other options:** Strict issue-number order, which would build #6 before the catalog it needs.

## 2026-11-17 — Where the zero-comment check lives

- **Chosen:** A fifth workspace package, `tools/zero-comment`, with its own type check, tests and build. `pnpm check`
  runs it from its build output after `pnpm build`.
- **Why:** It gets the same strict type check and tests as everything else, and its parser dependencies stay out of
  `protocol`, `hub`, `runner` and `web`.
- **Other options:** A root `scripts/` folder run through Node's type stripping; a module inside `hub`, which will
  enforce the constraint later.

## 2026-11-17 — Which files the zero-comment check reads

- **Chosen:** Every file `git ls-files --cached --others --exclude-standard` lists, so tracked files and new files that
  are not ignored. A tracked file deleted from disk is skipped. Files are matched by name: `.ts .mts .cts .tsx .d.ts`,
  `.js .jsx .mjs .cjs`, `.css`, `.html .htm`, `.md .markdown`, `.yml .yaml`, `.sh .bash`, `.ps1 .psm1 .psd1`,
  `.json .jsonc .json5`, and `Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `Containerfile`.
- **Why:** A worker runs `pnpm check` before committing; checking only the index would pass a new commented file until
  after it is committed.
- **Other options:** Tracked files only. Also checking formats with comments that the issue does not list (`.gitignore`,
  `.gitattributes`, `.npmrc`, TOML, XML and SVG), which can be added when the same failure happens twice.

## 2026-11-17 — Code embedded in other files

- **Chosen:** Comments in code embedded in a checked file fail too: `<script>` (JavaScript or JSON), `<style>`, `style`
  and `on*` attributes in HTML and in HTML inside Markdown, and the shell of `RUN`, `CMD` and `ENTRYPOINT` in shell form
  and of a `RUN` here-document in a Dockerfile. Not checked: fenced and indented code blocks in Markdown, YAML string
  values (block scalars included), `COPY` here-document content, and `<script>` of other types.
- **Why:** Embedded code is code in the repository, and its language is certain. A Markdown code block is quoted text
  whose language is only a hint, and a YAML string has no language at all.
- **Other options:** Check only each file's own language; also check Markdown code blocks by their info string.

## 2026-11-17 — Parsers behind the zero-comment check

- **Chosen:** `@babel/parser` for TypeScript and JavaScript, `@csstools/css-tokenizer` for CSS, `parse5` for HTML,
  `mdast-util-from-markdown` for Markdown, the CST of `yaml` for YAML, `jsonc-parser` for JSON, `sh-syntax` (mvdan/sh
  compiled to WebAssembly) for shell, and `dockerfile-ast` for Dockerfiles. PowerShell has no JavaScript parser, so it
  has a small lexer of its own covering strings, here-strings, subexpressions, braced variables, escapes and both comment
  forms; it treats `#` as a comment only at the start of a token (after whitespace or one of `; ( ) { } [ ] | & , =`), so
  `a#b` passes. A file that cannot be parsed fails the check.
- **Why:** Parsers know where strings, regular expressions, URLs and here-documents are, so they report no false
  comments. TypeScript 7's compiler has no JavaScript parser interface to use instead of Babel. PowerShell's own
  tokenizer needs `pwsh`, which macOS does not have by default.
- **Other options:** Pattern matching per language; calling PowerShell's tokenizer when it is installed; failing open on
  files that cannot be parsed.

## 2026-11-17 — Workspace tool chain

- **Chosen:** TypeScript 7.0, Vitest 5.1, Vite 8.3, React 19.3 and zod 4.6, pinned. Node 24 or later (`engines`), which is
  what this PC runs. Workspace packages export a `source` condition pointing at `src/index.ts`; the type check and Vitest
  resolve through it, so neither needs a build first, while each package's build resolves its dependencies through
  `dist`. Vitest runs every package as a project of one root configuration, with `testTimeout` and `hookTimeout` set
  to 0, which turns both limits off.
- **Why:** Current versions at the time of writing. One root test configuration keeps the timeout rule in one place.
- **Other options:** TypeScript project references with `tsc -b`; building before the type check; Node 26.

## 2026-11-17 — Hub libraries

- **Chosen:** Node's own `node:http` for HTTP, `ws` 8 for WebSocket, `jose` 6 for verifying the Access assertion, and
  Node's built-in `node:sqlite` (`DatabaseSync`) for SQLite.
- **Why:** `ws` and `jose` are the most used libraries of their kind and have no dependencies of their own. `node:sqlite`
  ships with Node 24, so the hub has no native module to compile or to approve as a build script in the Linux container;
  its synchronous interface suits one process owning one file. It still prints an experimental warning at start, which
  is cosmetic.
- **Other options:** Fastify or Hono for HTTP; `better-sqlite3`, which is a native addon; `jsonwebtoken` with
  `jwks-rsa`, two packages with more dependencies.

## 2026-11-17 — The front door's check

- **Chosen:** Only the `Cf-Access-Jwt-Assertion` header is read, not the `CF_Authorization` cookie. The token must be
  RS256 (checked from the header before any key is looked up, and again by `jose`), carry a key id published at
  `https://<ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`, have the issuer `https://<ACCESS_TEAM>.cloudflareaccess.com`,
  include `ACCESS_AUD` in its audience, and carry `exp` and `iat`; `exp` and `nbf` allow 30 seconds of clock skew. A
  token with an email and a subject and no `common_name` is a person; one with a `common_name` and no email is a service
  token; anything else is refused. Only a person whose email equals `OWNER_EMAIL`, compared in lower case, is admitted.
  Every refusal answers 403 with `{"error":"forbidden"}`, and the path is looked at only after the sign-in passes, so an
  unknown path without a sign-in also answers 403. Keys are cached for ten minutes; an unknown key id fetches the set
  again at most once every 30 seconds; a failed fetch refuses the request.
- **Why:** The header is what Cloudflare documents for origin checks, and the cookie adds nothing behind Access. Telling
  person from service token by those claims matches what Access issues for each, and keeps a service token out until
  #9 admits runners on purpose. Not distinguishing 401 from 403 tells a caller nothing about why it was refused.
- **Other options:** Also reading the cookie; no clock skew allowance; 401 for a missing assertion.

## 2026-11-17 — Hub configuration and state

- **Chosen:** Besides `ACCESS_TEAM`, `ACCESS_AUD` and `OWNER_EMAIL`, the hub reads `HUB_DATA_DIR` (required),
  `HUB_PORT` (default 8080) and `HUB_HOST` (default `0.0.0.0`). `ACCESS_TEAM` is the team name alone and `ACCESS_AUD` must
  be the 64-character lower-case hexadecimal tag Access shows. Every wrong value is reported at once, by name and never by
  value, and the hub exits with status 1. State is one file, `hub.sqlite`, in `HUB_DATA_DIR`, in WAL mode. Migrations are
  SQL strings numbered from 1 in `packages/hub/src/migrations.ts`, each applied in its own transaction and recorded in a
  `migrations` table; a database holding a migration the hub does not know refuses to open. The first migration creates
  a `hub` row with an instance id made at the first start, which is how a restart is seen to keep state. The health
  endpoint is `GET /health`, answering `{"status":"ok"}`, or 503 with `{"status":"unavailable"}` when the database does
  not answer. The signed-in API so far is `GET /api/session` and the WebSocket at `/ws`, which greets with a `hello`.
- **Why:** A `HUB_` prefix keeps the hub's own values apart from others in a shared environment file. Requiring the data
  folder avoids writing state somewhere nobody looks. Checking the tag's shape catches the common mistake of pasting the
  application's name or domain.
- **Other options:** `PORT` and `DATA_DIR` without prefix; a default data folder such as `/data`; `PRAGMA user_version`
  instead of a table; migrations as separate `.sql` files.

## 2026-11-17 — The command service

- **Chosen:** `CommandService` in `packages/hub/src/commands.ts` is the interface callers use: `start` takes a target
  name, a shell command, an account (`novan-xu` or `nuofan-island`, `novan-xu` when none is given) and an optional
  folder, stores the command and returns at once; `finished`, `get`, `list`, `output`, `subscribe` and `stop` follow it.
  A command's states are `pending` (in the gate), `held`, `running`, then one of `exited`, `stopped`, `dropped`,
  `failed` (it could not start: unknown target, missing token, bad folder, gate error) or `interrupted`. Output is kept as
  numbered chunks per stream, decoded as UTF-8, with no size limit. An unknown target or a missing token is recorded as a
  failed command rather than thrown, so the caller reads one kind of answer; a request that does not parse is thrown.
- **Why:** One interface for the brain's tools (#5), the page (#6) and runners (#9). Numbered chunks let a reader resume
  from the last chunk it saw without gaps or repeats.
- **Other options:** Returning output only at the end; a size cap on stored output; throwing for an unknown target.

## 2026-11-17 — The gate every command passes through

- **Chosen:** A `CommandGate` is one function called with the stored command and a control that can mark it `held` with a
  reason and that signals when the command is stopped while waiting. It answers `allow` or `drop` with a reason, at once
  or later. The hub's default gate allows everything. #4 replaces it through `startHub({ gate })`.
- **Why:** Holding, releasing and dropping are all expressed by when and how the gate answers, so callers and the service
  do not change when the confirmation lock arrives.
- **Other options:** A synchronous match function plus a separate hold queue; events the lock listens to.

## 2026-11-17 — Targets, shells and stopping

- **Chosen:** A target is a name and a `run` function. `hub` runs the command through Node's platform shell (`/bin/sh -c`
  on Linux and macOS, `cmd.exe /d /s /c` on Windows) in its own process group, with standard input closed. `nas` exists
  when `NAS_SSH_DESTINATION` is set (`NAS_SSH_PORT` and `NAS_SSH_IDENTITY` are optional) and runs
  `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -- <destination> bash -s`,
  writing a small script to its standard input that exports the credentials, runs the command with `sh -c` as a job of
  its own (`set -m`) and kills that job's whole process group when standard input closes. Stopping is immediate and
  forced: `SIGKILL` to the process group on Linux and macOS, `taskkill /T /F` on Windows, closing the script's input on
  the NAS. A command ends when its output pipes close, so it is not recorded as ended while a process it started still
  holds them. There is no time limit.
- **Why:** Credentials sent through standard input never appear in a command line on either machine. Closing the input
  also stops the remote command when the hub or the connection dies. `accept-new` lets the first connection from a new
  container work without a prepared `known_hosts`, and still refuses a changed host key. A forced stop is what the owner
  means by stop, and it cannot be ignored by the command.
- **Other options:** `ssh -tt`, which mixes the two streams and rewrites line ends; `SendEnv`, which needs the NAS's
  `sshd` to accept each variable; `SIGTERM` first with a grace period; bash for the hub's own commands.

## 2026-11-17 — Credentials in commands

- **Chosen:** Every command gets the chosen account's token as `GH_TOKEN` and `GITHUB_TOKEN`, plus `WOODPECKER_SERVER`,
  `WOODPECKER_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCESS_API_TOKEN` when the hub has
  them. On the hub the rest of the hub's environment is passed through, except `GITHUB_TOKEN_NOVAN_XU` and
  `GITHUB_TOKEN_NUOFAN_ISLAND`, so only the chosen account is present. On the NAS only those credentials are added to the
  login environment. A command whose account has no token fails before it starts, naming the missing variable.
  `CLOUDFLARE_API_TOKEN` is the name assumed for the Cloudflare API token that the design lists without a name.
- **Why:** `gh`, `git` through `gh`, and most tools read `GH_TOKEN` or `GITHUB_TOKEN`. Removing the other account's token
  keeps the per-command choice meaningful. Failing early is clearer than letting `gh` fall back to whatever login exists.
- **Other options:** Passing both account tokens to every command; running without a token when it is missing; a
  separate variable list per target.

## 2026-11-17 — Reading and stopping commands from outside the hub

- **Chosen:** Behind the front door: `GET /api/commands?limit=` (newest first, 50 by default, at most 500),
  `GET /api/commands/<id>`, `GET /api/commands/<id>/output?after=<seq>`, and `POST /api/commands/<id>/stop`, which needs
  `Content-Type: application/json`, answers 202 with the command as it is at that moment, and 415 otherwise. An unknown
  command or a malformed parameter answers 404. On `/ws` every page receives `command` messages for every change of
  state; a page sends `follow` with a command id and an optional `after`, and receives that command's stored output from
  there and then new output as it is produced, until it sends `unfollow`. A message the hub does not understand closes the
  socket with 1008. Starting a command is not offered over HTTP; the brain's tools in #5 call the service inside the hub.
- **Why:** The page needs to see commands as they run and to stop one; nothing in this issue needs to start one from
  outside. The JSON content type keeps a cross-site form from stopping a command through the owner's cookie.
- **Other options:** A start endpoint now; separate WebSocket paths per command; server-sent events.

## 2026-11-17 — Commands across a restart

- **Chosen:** When the hub closes it stops every unfinished command and records it as `interrupted`. When it starts, any
  command still recorded as `pending`, `held` or `running` (left by a hub that died) is recorded as `interrupted`, with
  the start time as its end time. Its stored output is kept.
- **Why:** A command cannot outlive the process that was reading its output, so "running" after a restart would be
  false. Held commands are not resumed because the gate's waiting lives in memory; #4 can change that.
- **Other options:** Leaving commands running on the NAS across a hub restart and reattaching; resuming held commands.

## 2026-11-17 — How the confirmation lock reads a command

- **Chosen:** The list is data in `packages/hub/src/irreversible.ts`: six forms (`repository-deletion`,
  `repository-publication`, `default-branch-rewrite`, `data-deletion`, `credential-change`, `file-deletion`), each with
  command patterns, API request rules, text rules or a rule over what a command deletes, writes or moves. Every command
  is read twice, once as POSIX shell text and once as PowerShell text, and held if either reading matches. The reading
  splits on `&&`, `||`, `;`, pipes and newlines; removes quotes; strips wrappers (`sudo`, `env`, `nohup`, `timeout`,
  `xargs`, `npx` and others); follows `cd` and `Set-Location`; and reads inside `$(...)`, backticks, subshells, script
  blocks, `bash -c`, `pwsh -Command` and `-EncodedCommand`, `cmd /c`, `ssh` remote commands, `eval`, `docker exec`,
  `find -exec` and shell here-documents, to a depth of eight. `gh api`, `curl`, `wget`, HTTPie and `Invoke-RestMethod`
  are read as API requests to GitHub and Cloudflare. Anything the reading cannot see is held: a path built from a
  variable, a delete fed by a pipe or `xargs`, a relative path with no known folder, a force-push whose destination is
  unknown, a request body read from a file. The default branches are `main`, `master` and `trunk`. The data-volume forms
  apply on every target, since the hub cannot tell where a Docker client points. Not held: `DROP TABLE` and `TRUNCATE`,
  local history rewrites (`reset`, `rebase`, `commit --amend`) until they are pushed, force-pushing tags or other
  branches, `internal` visibility, and anything inside a script file.
- **Why:** The design accepts that the list matches known forms and cannot see inside a script. Reading both shells
  costs nothing when a command is valid in only one of them, and a needless hold costs one click while a miss cannot be
  undone. Keeping the forms as data makes the list reviewable in one place.
- **Other options:** One dialect chosen per target; a full shell parser such as mvdan/sh, which still could not read
  PowerShell; holding every `rm`, every force-push and every `docker` command; reading the repository's default branch
  from GitHub before deciding.

## 2026-11-17 — Project folders and credential paths

- **Chosen:** `HUB_PROJECT_FOLDERS` is a comma-separated list of absolute folders (`/srv/projects`, `~/work`, `C:\work`);
  it is empty by default, so until it is set every delete is held. A delete is outside project folders unless its
  target is strictly inside one of them; the folder itself is outside. Paths under `/` and `~` compare with case, drive
  and UNC paths without it. `HUB_CREDENTIAL_PATHS` is a comma-separated list of glob patterns added to a built-in list
  (`secrets/` folders, `.env` files, keys and certificates, SSH private keys and `authorized_keys`, `.netrc`,
  `.git-credentials`, `.npmrc`, the `gh`, Docker, AWS, Kubernetes, Cloudflare tunnel and Codex logins, `~/.superagent/`);
  a pattern starting with `!` excludes, and `*.pub`, `*.example`, `*.sample`, `*.template` and `*.dist` are excluded by
  default. Deleting, moving away, overwriting, appending to or editing such a file is held wherever it is, as are
  `gh secret delete` and `set`, `gh auth logout`, deleting SSH, GPG and deploy keys, `docker secret rm`,
  `kubectl delete secret`, `wrangler secret`, `cloudflared tunnel delete`, and the GitHub and Cloudflare API calls that
  delete or roll secrets, tokens, service tokens and tunnels.
- **Why:** Which folders hold projects depends on the deployment (#8), and holding everything until it is said is the
  safe default. Adding to the credential list, rather than replacing it, keeps a typo in the setting from removing the
  protection.
- **Other options:** A default project folder such as `/srv/projects`; treating the temporary folder as a project
  folder; letting the setting replace the built-in credential list.

## 2026-11-17 — Releasing a held command

- **Chosen:** A held command is released only through `POST /api/commands/<id>/release` and refused through
  `POST /api/commands/<id>/refuse`, each with a JSON body `{"fingerprint": "<sha256>"}`. The fingerprint covers the
  command's id, target, text, account and folder, and is stored when the command is held; a release must name it, the
  held record must still match it, and the command run is the record the gate was given. The lock itself verifies the
  request's raw `Cf-Access-Jwt-Assertion` and accepts only a person whose email is `OWNER_EMAIL`; the server's front
  door is not trusted for this, so admitting service tokens there later (#5, #9) does not let them release. Code inside
  the hub has no way to release without that signed assertion. The request must also carry an `Origin` whose host
  equals the `Host` header, a `Sec-Fetch-Site` of `same-origin` when present, and `Content-Type: application/json`.
  Answers: 202 with the command; 403 for anyone but the owner or another origin; 415 for another content type; 400 for a
  body without a fingerprint; 409 for a wrong fingerprint or a hold already answered; 404 for a command never held.
  `GET /api/holds` lists what waits, with the fingerprint. A hold is answered once and recorded with who answered and
  when. The caller can still stop a held command, which records it as withdrawn. Refused commands end as `dropped`
  with the reason "The owner refused it".
- **Why:** Only the owner's browser can produce a fresh assertion signed by Cloudflare for the owner's Google account,
  so requiring it makes the rule structural rather than a convention. The fingerprint ties the click to exactly what
  the owner saw. The origin and content-type checks keep another site open in the owner's browser from answering for
  them.
- **Other options:** Trusting the identity the front door already checked; a one-time code shown on the page; releasing
  by command id alone; comparing the origin with a configured public URL instead of the `Host` header.

## 2026-11-17 — Held commands across a restart

- **Chosen:** This replaces the part of "Commands across a restart" about held commands. When the hub closes, a
  command waiting for the owner stays `held`. When it starts, every `held` command is given to the gate again, and the
  lock waits for the owner's answer to it as before; a hold already marked answered is cleared and asked again. A held
  command whose stored target, text, account or folder no longer matches its fingerprint is dropped with the reason
  "The command changed after it was held, so it was not run". `pending` and `running` commands are still recorded as
  `interrupted`.
- **Why:** A held command has not started, so nothing about it is lost by a restart, and the issue asks that it wait
  until answered.
- **Other options:** Marking held commands interrupted and asking the brain to start them again.

## 2026-11-17 — Test servers and the ports fetch refuses

- **Chosen:** Tests that call the hub with `fetch` start it through `startTestHub` or `listenForFetch` in
  `packages/hub/src/testing/http.ts`, which listen again when the system hands out a port that `fetch` refuses (6000,
  10080 and the rest of the Fetch standard's list).
- **Why:** This PC's dynamic port range starts at 1024, so a test listening on port 0 sometimes got such a port and
  failed with "bad port", which has nothing to do with the code under test.
- **Other options:** Fixed ports per test, which collide when test files run in parallel.
