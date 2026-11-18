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

## 2026-11-17 — Temporary folders and a project's own `.env`

- **Chosen:** Two exceptions to the confirmation lock, both kept as data in `packages/hub/src/irreversible.ts`.
  Deleting something strictly inside a system temporary folder runs without a hold. The folders are `/tmp`,
  `/var/tmp`, `$TMPDIR`, `$TMP` and `$TEMP`, in every spelling the reader sees: `${TMPDIR}`, `$env:TEMP`,
  `${env:TMP}` and `%TEMP%`. A variable assigned from `mktemp` with no folder of its own (`dir=$(mktemp -d)`,
  `local f=$(mktemp -t x.XXXX)`) counts as a folder inside `$TMPDIR` until it is assigned again. `find` with a filter
  such as `-name` or `-mtime`, or with `-mindepth 1`, deletes inside its root rather than the root itself. Still held:
  the temporary folder itself, a path that climbs out of it with `..` (above a variable or `~` the reader cannot tell
  where `..` leads), a variable of another name, `mktemp -p <folder>`, and a credential file in a temporary folder.
  Inside a project folder, `.env` and `.env.*` are the project's local configuration: writing, copying onto,
  appending to, moving and deleting them runs without a hold. The built-in credential list still applies to them
  outside project folders. Anything named in `HUB_CREDENTIAL_PATHS` is a credential wherever it is, project folder
  included.
- **Why:** A needless hold stops unattended work until the owner clicks, and these two are routine: clearing scratch
  files, and setting up a project's local `.env` from `.env.example`. The deployment's real secrets are named in
  `HUB_CREDENTIAL_PATHS` or live outside project folders, so they stay protected.
- **Other options:** Leaving both held; treating `/tmp` as a project folder through `HUB_PROJECT_FOLDERS`, which would
  also allow deleting `/tmp` itself; exempting every `*.env` file inside project folders.

## 2026-11-17 — The Chinese catalog

- **Chosen:** A sixth workspace package, `packages/catalog` (`@super-agent2/catalog`), used by the hub and the page and
  not by `protocol`. `messages` is one flat object of dotted keys (`navigation.workbench`, `command.state.running`,
  `hold.reason`, `refusal.not_found`) kept `as const`, so a missing or misspelled key is a type error. `text(key, values)`
  fills `{name}` placeholders; the placeholder names are read from the message's own type, so a missing, misspelled or extra
  value is a type error too, and a value may be a string or a number. A count is a placeholder (`{count} 项`): Chinese has
  no plural forms, so there are none here either. There is no fallback language and no lookup that can miss at run time.
  The keys for states, hold answers and refusals are the protocol's own enum values, so the page reaches them with
  `command.state.${state}`. Its tests require every message to hold Chinese and no other English, apart from `Super-agent2`,
  `hub` and `GitHub`, and the hub's tests require a key for every command state, hold answer and refusal.
- **Why:** Both the page and the hub need the same text, and `protocol` is the messages between parts, not their words.
  Flat keys need no path type or cast. Seeding only what exists (the five navigation items, the command and hold states
  and refusals of #3 and #4, and the product name) follows the rule not to invent labels for views that do not exist.
- **Other options:** Nested objects with a path type; putting the catalog inside `protocol`; a message-format library such
  as ICU; separate catalogs for the hub and the page.

## 2026-11-17 — The hub stores its own reasons in Chinese

- **Chosen:** The reasons the hub itself gives (a command refused, withdrawn, changed after it was held, interrupted by a
  restart, sent to an unknown target or without a token) and the hold's text (`Held until the owner confirms it: …`) are
  built from the catalog when they happen and stored as Chinese text in the same `reason` and `description` columns as
  before. The six forms of the confirmation lock take their `description` from the catalog. Raw material stays as it is: a
  hold's `evidence` (the command or the path found in it), the message of an error thrown by the system (`spawn` failures
  and the like), and the HTTP status lines.
- **Why:** The owner only ever sees these through the page, which shows them unchanged, so one stored sentence is simplest
  and needs no migration. The reasons that only wrap raw material, such as `evidence`, are what the owner needs to see as
  it is.
- **Other options:** Storing a code and parameters and translating when shown, which lets the wording change later but gives
  every reader two things to keep in step; storing English and Chinese side by side.

## 2026-11-17 — Text an LLM generates for the owner

- **Chosen:** `GeneratedText` in `packages/protocol/src/generated.ts` is `{ en, zh }`. Both must be non-empty after
  trimming, and `zh` must contain at least one Chinese character, so an English sentence pasted into `zh` is refused as
  well as a missing one. A proper noun or technical term inside a Chinese sentence is fine; a copy that has none at all is
  not. `chineseOf` returns the copy the page shows.
- **Why:** The refusal belongs at the boundary, where the message is parsed, and every later message that carries
  generated text (a ticket's title and summary, a report, guidance, a stop reason, a notice) gets it by using the type.
  Checking for a Chinese character catches the most likely mistake, a model that writes English twice.
- **Other options:** Only checking that `zh` is present; a language detector; keeping the two copies as separate fields on
  every message.

## 2026-11-17 — What counts as literal text in the page's markup

- **Chosen:** A new tool, `tools/markup-text`, run by `pnpm check` after the build as `pnpm markup`, parses every `.tsx`,
  `.jsx` and `.html` file under `packages/web` (not tests) with Babel and parse5 and fails on any literal that holds a
  letter in any script, naming the file, line and column. That covers text between tags; the shown attributes
  (`placeholder`, `title`, `alt`, `aria-label`, `aria-description`, `aria-placeholder`, `aria-roledescription`,
  `aria-valuetext`, `label`, `caption`, `legend`, `summary`, `text`, `tooltip`, `hint`, `heading`, `description`,
  `message` and `children`, on elements and on components alike); and the literals that flow into those places through a
  conditional, a logical or `+` expression, a template string, an array, a callback's return value, a `const` that is not
  reassigned, or a lookup in a literal object or array (the specific property when it is named). A string that is not
  shown (`className`, `href`, `key`, `data-*`, `type`, `role`, `style`, and so on) is not looked at. Whitespace,
  digits, punctuation and symbols are not language and are allowed, so `·`, `—`, `×` and `{404}` pass. Chinese written
  in the markup fails like English: the interface's own text is written only in the catalog. `index.html` follows the same
  rule, so the page's title is set from the catalog in `main.tsx`. A file that cannot be parsed fails.
- **Why:** The goal is that nothing on screen is English; a letter test finds that without a list of words. Following a
  value from where it is shown is what lets the rule see `{ok ? "Saved" : …}` and a label held in a constant without
  flagging `className="btn"`. Naming the shown attributes, rather than every attribute, is what keeps class names, ids and
  URLs out.
- **Other options:** Flagging every string literal in the page's files; flagging only text between tags; a list of
  attributes to skip instead of a list to read; also flagging digits.

## 2026-11-17 — The brain as a package of its own

- **Chosen:** A seventh workspace package, `packages/brain` (`@super-agent2/brain`), run as `node dist/main.js` in its
  own container. It reads `BRAIN_HUB_URL`, `BRAIN_TOKEN_FILE` and `BRAIN_WORKSPACE` (all required), `BRAIN_PROVIDERS`
  (the order of `gpt` and `claude`, default `gpt,claude`; DeepSeek is always last and cannot be listed), the model,
  effort and program of each provider (`BRAIN_GPT_MODEL`, `BRAIN_GPT_EFFORT`, `BRAIN_CODEX_PROGRAM`, and the same for
  `CLAUDE` and for `DEEPSEEK` with `BRAIN_DSH_PROGRAM`, defaulting to the design's starting models and to `codex`,
  `claude` and `dsh` on the path) and `BRAIN_MAX_OPEN` (programs kept running at once, default 4; the least recently
  used idle one is stopped first, and its session is resumed when needed). A program given as a `.js` or `.mjs` file is
  run with Node. The three programs sit behind one interface, `ProgramAdapter`, whose handle starts a turn, steers it,
  interrupts it and closes; the conversation logic in `brain.ts` is written once and tested with a fake program against
  a real hub. Hand-run checks against the real programs are in `tools/brain-live`
  (`node tools/brain-live/dist/cli.js <gpt|claude|deepseek|failover>`), outside `pnpm check`.
- **Why:** The brain runs the vendors' programs, which the hub's container does not need, and it must restart on its own
  without the hub. One interface keeps provider choice and handover in one place.
- **Other options:** Running the programs inside the hub; the vendors' SDK libraries, which wrap the same programs but
  add a dependency per vendor.

## 2026-11-17 — How each program is driven

- **Chosen:** Codex through `codex app-server` (JSON-RPC lines on stdio): `thread/start` or `thread/resume` with
  `approvalPolicy: never`, `sandbox: danger-full-access`, the model, and `config` carrying `model_reasoning_effort` and
  the hub's MCP server, passed again on every resume because Codex does not keep per-thread configuration; then
  `turn/start`, `turn/steer` and `turn/interrupt`. Claude Code through `claude -p --input-format stream-json
  --output-format stream-json --verbose --include-partial-messages --model … --effort … --dangerously-skip-permissions
  --setting-sources project --mcp-config <json> --strict-mcp-config`, with `--session-id <uuid>` for a new conversation
  and `--resume <uuid>` after it; a message is a `user` line on standard input and an interrupt is a `control_request`
  of subtype `interrupt`. The environment given to Claude Code drops every `CLAUDE*`, `ANTHROPIC*` and `MCP_*` variable
  except `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`, maps `BRAIN_CLAUDE_OAUTH_TOKEN` to
  `CLAUDE_CODE_OAUTH_TOKEN`, and sets `IS_SANDBOX=1` when running as root on Linux, where Claude Code otherwise refuses
  full access. `dsh` through `dsh --profile sdk --patch <file>` (JSON-RPC 2.0 lines): `initialize` with the
  `deepseek-account` route, model and effort, `session/resume` for an existing session, `session/prompt`, and
  `DSH_PERMISSION_MODE=danger-full-access`. The patch file adds the hub's MCP server and turns off the upload of
  session logs to DeepSeek. The hub's token reaches each program through the environment variable
  `SUPER_AGENT_HUB_TOKEN`, never a command line or a file. Everything was taken from the programs' help, generated
  schemas and experiments on this PC with codex-cli 0.163.0, Claude Code 2.1.326 and dsh 0.2.1-rc.2.
- **Why:** Each is the program's own long-lived headless interface with structured events, sessions by id and a way to
  stop. The `acp` profile of dsh can cancel, but reports why a turn failed only as an error message, while the `sdk`
  profile gives an error code (`ACCOUNT_QUOTA`, `RATE_LIMIT` and so on), which provider choice needs. A small dsh plugin
  could add steering and cancelling to the `sdk` profile, but it would use internal interfaces of dsh.
- **Other options:** `codex exec --json` and `exec resume`, one process per turn with no text deltas, no steering and
  no interrupt; `dsh --profile acp`; a dsh control plugin.

## 2026-11-17 — What the programs cannot do, and the nearest honest behaviour

- **Chosen:** A message sent during a turn goes into that turn with Codex (`turn/steer`) and Claude Code (a second
  `user` line, which Claude Code folds into the running turn at its next model request). When Claude Code answers such a
  message as a turn of its own because the first was already finishing, the brain keeps its turn open until every
  message given to it has been answered, so the owner sees one turn. dsh cannot take a message into a running turn: the
  brain queues it and starts the next turn with it as soon as the current one ends. dsh has no interrupt either: the
  brain stops the program, records the turn as interrupted, and resumes the session (which dsh repairs) in a new process
  for the next turn. A Codex interrupt does not stop a shell command Codex itself started; its late output is ignored.
  A Claude Code interrupt also cancels messages queued in that turn. dsh sends whole messages rather than text as it is
  written, so its text arrives a step at a time. A message that reaches the brain in the moment between choosing a
  provider and starting the program is given to the program as soon as the turn starts.
- **Why:** The issue asks for the nearest honest behaviour where a program cannot do something, not an imitation.
- **Other options:** Interrupting a dsh turn to send it the new message; letting Claude Code's queued messages run
  after an interrupt.

## 2026-11-17 — The link between brain and hub

- **Chosen:** The brain connects to the hub directly, not through the front door: a WebSocket at `/brain/link` and MCP
  over HTTP at `/brain/mcp`, both requiring `Authorization: Bearer <token>`. Paths under `/brain/` accept only that
  token and never the owner's Access assertion; every other path accepts only the assertion and never the token. The
  token is 32 random bytes in base64url, made by the hub at its first start in `HUB_BRAIN_TOKEN_FILE` (default
  `<HUB_DATA_DIR>/brain.token`, mode 0600) and read by the brain from `BRAIN_TOKEN_FILE`; it is compared by SHA-256
  digest in constant time and never printed. The link's messages are in `packages/protocol/src/brain.ts`: the hub sends
  `input` (an owner message or a hub notice), `interrupt` and `prepared`; the brain sends `hello` (with the turns it is
  running), `turn.started`, `input.taken`, `provider.changed`, `text`, `tool.started`, `tool.output`, `tool.finished`,
  `turn.finished`, `session` and `prepare`. While the link is down the brain keeps its messages and sends them in order
  after its next `hello`, and asks again any `prepare` not answered; it reconnects after one second. One brain is linked
  at a time; a new link replaces the old.
- **Why:** The two containers share the NAS's internal network, so the brain needs no Cloudflare service token, and a
  token file made by the hub needs no step at deployment. Keeping the brain's token off the owner's paths means it
  cannot release or refuse a hold; that is tested.
- **Other options:** A Cloudflare Access service token for the brain; the token in an environment variable set by the
  deployment; HTTP polling instead of a WebSocket.

## 2026-11-17 — The hub keeps the record of every conversation

- **Chosen:** Migration 4 adds `conversations`, `turns`, `conversation_entries`, `program_sessions` and
  `brain_commands`. An entry is an owner message, a notice, the brain's text or a tool call with its output; text and
  output grow in place as the brain streams them. An owner message and a notice meant for the brain carry a `taken`
  flag and are delivered again after every `hello` until a turn takes them, so a message sent while the brain is away
  or restarting is answered when it is back. `program_sessions` holds each provider's program session per conversation
  and `through`, the last entry that session has seen, advanced when one of that provider's turns ends. When a turn
  starts, the brain asks the hub (`prepare`) for that provider's session and the entries after its `through`: none when
  it answered last, the part it missed when another provider answered in between, everything for a new session. The
  brain gives those as text before the owner's message, or, when it switches provider in the middle of a turn, asks the
  new one to continue. A turn the hub records as running that the brain does not report in its `hello` is recorded as
  interrupted with a reason from the catalog; a turn the brain still runs that the hub has already ended is
  interrupted. A session the program reports as gone is replaced by a new one given the whole conversation.
- **Why:** The hub is the one place that survives every restart and sees every provider, so it can hand over exactly
  what a provider missed.
- **Other options:** The brain keeping its own state on a volume; giving every provider the whole conversation each
  time; summarising the conversation for a handover.

## 2026-11-17 — Choosing a provider

- **Chosen:** Each turn starts with the first provider in the configured order that is not known to be out until a
  later time. A provider that reports an exhausted allowance or a rate limit (Codex `usageLimitExceeded`,
  `rateLimitExceeded` or HTTP 429; Claude Code's `rate_limit` or `billing_error` errors or a `rejected`
  `rate_limit_event`; dsh `ACCOUNT_QUOTA`, `QUOTA` or `RATE_LIMIT`) is skipped until the reset time it reported, when
  it reported one. A provider that fails in any other way (sign-in, overload, a crash, an unknown model) is skipped for
  the rest of that turn and tried again at the next. The turn continues with the next provider, which is told what
  happened so far; DeepSeek is last and so answers only while the others are unavailable. When none is left, the turn
  fails with each provider's reason. Nothing is decided from how long anything takes.
- **Why:** The issue says the next one answers when the current one is out of allowance or failing, from what the
  program reports. Trying a failed provider again at the next turn lets the preferred one return without a timer.
- **Other options:** Asking each program for its remaining allowance before every turn; a fixed back-off; staying with
  the provider that answered last.

## 2026-11-17 — The hub's tools for the brain

- **Chosen:** The hub serves MCP itself at `/brain/mcp`: stateless Streamable HTTP with JSON responses, written by hand
  (`initialize`, `ping`, `tools/list`, `tools/call`; a notification gets 202 and `GET` gets 405), for protocol versions
  `2025-11-25` back to `2024-11-05`. The tools are `run_command` (target, command, account, folder), which starts the
  command through the command service and waits until it ends or is held; `read_command` (state and output after a
  chunk number); and `stop_command`. Output given to the model is clipped to 40,000 characters, keeping the start and
  the end; the full output stays readable. A held command answers at once that it is held and why, that the brain cannot
  confirm it, and that it will be told the outcome. When the command later ends (released and run, refused, or
  withdrawn) the hub adds a notice to the conversation and gives the brain a `[hub]` message with the outcome and its
  output. A tool call the program cancels stops the command it waited for, unless the command is held. The conversation
  is named in the `x-super-agent-conversation` header, set per conversation. There is no allow-list and no check beyond
  the command service's. The programs are told to wait up to a day for a tool.
- **Why:** Three small methods do not justify the official SDK's dependencies, and a stateless server survives restarts
  of either side. Waiting for the end is how a command reads to the model; the lock already decides what waits.
- **Other options:** `@modelcontextprotocol/sdk`; a stdio MCP server in the brain that forwards to the hub; answering
  at once with an id and polling.

## 2026-11-17 — Conversations for the page

- **Chosen:** Behind the front door: `GET /api/conversations?limit=` (newest first, with whether the brain is linked),
  `POST /api/conversations` (a new conversation, 201), `GET /api/conversations/<id>` (the conversation, its turns and
  entries), `POST /api/conversations/<id>/messages` with `{"text": …}` (202 with the entry) and
  `POST /api/conversations/<id>/interrupt` (202). Each POST needs `Content-Type: application/json`. On `/ws` every page
  receives `conversation`, `turn` and `brain` messages; a page sends `watch` with a conversation and an optional `after`
  and receives that conversation's entries after `after` together with every entry of a turn still running, then each
  new or changed `entry` and each `delta` of text or output as it is written, until `unwatch`. A conversation's title is
  the first line of its first message, up to 80 characters. Interrupting while the brain is away ends the turn at once.
  The labels for conversation and turn states, the hub's reasons and its notices are in the catalog.
- **Why:** The same shape as the command routes of #3, so the page of #6 follows both the same way.
- **Other options:** Server-sent events per conversation; sending the whole entry on every delta.

## 2026-11-17 — The brain's guidance

- **Chosen:** `packages/brain/guidance/AGENTS.md`, copied into the brain's workspace as `AGENTS.md` at start. Codex and
  dsh read it from the working folder, and Claude Code reads it when the folder has no `CLAUDE.md`. Claude Code runs
  with `--setting-sources project`, so a workspace outside the home folder does not pick up a user's own `CLAUDE.md`.
  It says to converse in Chinese, to act through the hub's tools, and how held commands and `[hub]` messages work.
  Nothing relies on it.
- **Why:** The design keeps guidance in `AGENTS.md`, and one file read by all three programs cannot drift.
- **Other options:** Developer instructions for Codex, `--append-system-prompt-file` for Claude Code and a persona
  patch for dsh, one per program.

## 2026-11-17 — How the hub serves the page

- **Chosen:** The hub serves the built page from `HUB_PAGE_DIR`, by default `packages/web/dist` found next to the hub's
  own files, behind the front door like everything but `/health`. The page's routes are defined once in
  `packages/protocol/src/page.ts`: `/`, `/workbench`, `/conversations`, `/conversations/<id>`, `/history`, `/memory` and
  `/settings`; each answers `GET` and `HEAD` with `index.html` and `Cache-Control: no-cache`. `/assets/<name>` answers a
  file of the build's `assets` folder by name only (no folders, no leading dot, a known extension) with
  `Cache-Control: immutable`, since Vite puts a content hash in every name. Every page answer carries a Content Security
  Policy that allows only the page's own origin (`script-src 'self'`, `style-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`), plus `nosniff`, `no-referrer` and `X-Frame-Options: DENY`. Anything else stays a JSON 404,
  and with no build present the page's routes answer 404 too. Files are read on each request.
- **Why:** Listing the routes in one shared place lets the hub answer exactly the paths the page understands, so an API
  typo still gets a JSON 404 rather than the page. Reading per request lets a rebuilt page show without restarting the
  hub.
- **Other options:** Answering `index.html` for every unknown path; loading the files into memory at start; serving
  the page from a separate static server.

## 2026-11-17 — The page's live state

- **Chosen:** One WebSocket per page. Entries reach the page only through `watch` on that socket, whole or as deltas,
  never from the HTTP reading of a conversation; HTTP gives the conversation and its turns, which are merged so an older
  reading never undoes a newer change (a conversation by `updatedAt`, a turn never going back from finished to
  running). A whole entry replaces the page's copy; a delta appends; an entry the page has never seen ignores deltas; the
  owner's own message from the `POST` answer is added only if the socket has not already brought it. After a
  reconnection the page watches again from just before its oldest entry that may still change (an owner message not
  yet taken, a command still running, anything of a turn not known to be finished), and reads the list and the open
  conversation again. It reconnects after 0.5, 1, 2, 4, then every 8 seconds, at once when the browser reports it is
  back online, and when a hidden tab becomes visible without a connection. These rules are plain functions in
  `packages/web/src/live/` with their own tests.
- **Why:** One ordered channel for entries is what makes deltas and whole entries interleave without loss or
  repetition; the hub already resends every entry of a running turn on `watch`.
- **Other options:** Reading the whole conversation again after every reconnection and replacing the page's copy;
  sequence numbers on deltas, which would need a protocol change; a heartbeat message, which the protocol does not
  have.

## 2026-11-17 — The look of the page and of 对话

- **Chosen:** The prototype's stylesheet is copied unchanged into `packages/web/src/styles/prototype.css`; what the
  prototype does not have (folded commands, Markdown inside a message, the conversation picker) is added in
  `packages/web/src/styles/page.css` with the prototype's tokens. Light or dark follows the system setting until 设置
  (#21) offers the choice; the accent is the prototype's. The sidebar's status card shows hub and 大脑, without the
  prototype's machine line (runners come with #9), and says `hub` as the catalog already does rather than the
  prototype's 中枢. Earlier conversations are listed in the right-hand rail on wide screens and in a bottom sheet opened
  from the conversation's title on narrower ones. 新对话 opens an empty conversation that is created on the hub only
  when its first message is sent, so no empty conversations pile up; 对话 in the navigation returns to the last
  conversation opened, and `/` opens the most recent one. A command or tool call is one folded line (state dot, tool
  name, the command it runs) that opens to its input and output exactly as they are; a command still marked running in
  a turn that has ended shows a hollow dot. The owner's messages show as typed; the brain's text is Markdown through
  `react-markdown` with GitHub's extensions, raw HTML is shown as text, script links are dropped, links open apart from
  the page and images are shown as links, not loaded. Enter sends on a keyboard with a mouse and adds a line on a touch
  screen, and never while an input method is composing. Navigation uses real links so the routes work as addresses.
- **Why:** The issue asks to reuse the stylesheet rather than rewrite the look; the additions only fill what the
  prototype never showed. Folding keeps a long session readable on a phone.
- **Other options:** Importing the stylesheet from `docs/ui/prototype/`, which would tie the build to a reference
  copy; a theme switch now; creating a conversation on the hub when 新对话 is pressed; showing commands unfolded.

## 2026-11-17 — Seeing the page on this PC

- **Chosen:** A workspace tool, `tools/page-dev`, run by hand (`pnpm check` only type-checks and builds it) and outside
  every production path. It generates
  its own RSA key, starts the hub in its own process with that key as the Access key set, starts the brain in the same
  process, and listens on `http://127.0.0.1:5180`, forwarding every request and WebSocket to the hub with a fresh signed
  assertion for `owner@example.com`. The default brain is a scripted program (`--brain demo`) that streams a reply,
  runs a pretend command with output arriving line by line, takes a message sent during the turn into that turn, stops
  when interrupted, and writes forty paragraphs when the message contains 长; `--brain claude` uses the real `claude`
  program with the design's model (`--model` to change it), and `--brain none` starts no brain. State is kept in
  `.state/page-dev` (`--data` to change it, `--fresh` to start empty). `/__harness/offline` drops every connection and
  refuses new ones until `/__harness/online`, to try losing the network. To use it: `pnpm install`, `pnpm build`, then
  `node tools/page-dev/dist/cli.js`, and open `http://127.0.0.1:5180/` (after changing the page, `pnpm --filter
  @super-agent2/web build` again and reload).
- **Why:** The hub admits only a signed Access assertion and must not gain a bypass; a proxy that signs with a key the
  hub was started with exercises the real front door unchanged. A scripted brain makes streaming, steering and
  interrupting repeatable without spending a subscription.
- **Other options:** A development flag in the hub that skips the check; Vite's development server with a proxy, which
  would serve the page from a different origin than the hub; the fake programs of the brain's tests, which answer at
  once and so cannot show a turn in progress.

## 2026-11-17 — What waits, and how the page learns of it

- **Chosen:** `packages/protocol/src/waiting.ts` defines a card as a union on `kind`, so far only `hold` (the held command, its hold and the hold's fingerprint), each with a `key` of the form `<kind>:<id>` and the time it began to wait. The hub keeps the list in `packages/hub/src/waiting.ts`: a command is waiting while the lock has an unanswered hold for it and the command's own state is still `held`, newest first. The page learns of it through the `/ws` it already has: a `waiting` message with the whole list is sent after `hello` and again whenever the list changes, and `GET /api/waiting` gives the same list. A change is noticed from the command events, one microtask later, because the lock registers its waiter just after the command is marked held; after the owner's answer the server refreshes the list before it replies. The new kinds (#23, #16 and the brain's questions) add a member to the union and a card component, and change nothing else.
- **Why:** A whole list per message means a page that reconnects, or a second device, can never be left holding a card that is gone, which is the failure that matters when the button is irreversible. Deriving from the command's state as well as the lock's waiters covers a command that was stopped while it waited, where the lock forgets it only after the command has already ended.
- **Other options:** Sending `added` and `removed` messages; the page reading `/api/holds` on every command event; the page deriving cards from `command` events alone, which carry no fingerprint.

## 2026-11-17 — What a confirmation card shows and how 确认 is guarded

- **Chosen:** A card shows the form of the hold (the Chinese description the hub stored from the catalog) as a chip, the target and the account as chips with an icon and no visible label, the folder when there is one, and the full command in a monospace block that wraps and scrolls inside 60% of the screen height. Blank-looking characters are written out as `U+202E` and the like: control characters other than tab and a line end, format characters such as zero-width spaces and bidirectional marks, spaces other than the plain space, and a few blank letters. Nothing else in the command is altered. 确认 takes two presses: the first turns the buttons into 取消 and a red 确认, and 取消 comes first and takes the focus, so a second tap at the place of the first press cancels instead of confirming. 拒绝 takes one press, since a refused command only has to be asked for again. While an answer is on its way both buttons are disabled, and the page refuses a second answer for the same card itself, before any rendering. A failed answer returns the card to its first state with the reason. The cards are newest first.
- **Why:** A command with a hidden character can look like something else, and the whole point of the card is that the owner sees what will run. On a phone a single tap is too easy to make by accident, and moving the confirming button is cheaper than a timer or a dialog. Newest first puts what has just arrived where a phone shows it.
- **Other options:** A press-and-hold button; a dialog; typing a word to confirm; oldest first; showing the hub's shortened evidence text; showing a label beside the target, account and folder.

## 2026-11-17 — Where the page offers notifications

- **Chosen:** A switch, with the label 通知, at the right of the 等你 heading in 工作台. It is shown only when the hub has VAPID keys and the browser can do push. When the browser has refused notifications it is disabled and a line says to allow them in the system settings; on an iPhone that has not added the page to its home screen, where the browser has no push at all, a line says to add it first. Turning it on asks for permission, subscribes with the hub's public key and tells the hub; turning it off tells the hub and drops the subscription. On every start the page tells the hub again about a subscription it already has, and drops one that was made with keys the hub no longer uses.
- **Why:** 设置 (#21) does not exist yet, and the owner needs the switch next to what it is about. A switch with no explanation is enough when it works; the two lines exist only for the two cases where it cannot.
- **Other options:** Waiting for 设置; a banner asking at first visit, which iPhone refuses without a tap anyway.

## 2026-11-17 — Push messages, keys and subscriptions

- **Chosen:** The hub sends Web Push itself with Node's own crypto, `jose` and `fetch`, no push library: RFC 8291 encryption (`aes128gcm`, tested against the RFC's own example) and an ES256 VAPID token valid for 12 hours with the audience of the push service. `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are the usual URL-safe base64 of the uncompressed public key and the 32-byte private key; the hub checks that they belong together and reports a problem by name, never by value. Without them the hub starts, `GET /api/push` says it has no key, and the subscription routes answer 404. An optional `VAPID_SUBJECT` (`mailto:` or `https:`) is the contact sent to the push service; without it the subscribing page's own origin is used, so the owner's email address is never sent to a push service. Subscriptions are rows of a new table, tied to the public key they were made with and used only while it is current; the endpoint must be `https:` (or `http:` on a loopback host, for the harness), the keys must have the sizes the standard gives, and `POST` and `DELETE` on `/api/push/subscription` need the same same-origin and JSON checks as the lock's answers. Messages have a day to live and urgency high. A 404 or 410 from the push service removes the subscription; any other failure is ignored.
- **Why:** Own code is about a hundred lines and takes an injectable `fetch`, which the tests and the harness need, and `web-push` brings five dependencies and its own HTTPS client. Keeping the contact out of the message avoids sending the owner's address to Google, Apple and Mozilla.
- **Other options:** `web-push`; the owner's email as the subject; `VAPID_SUBJECT` required.

## 2026-11-17 — When the hub sends, and what a notification says

- **Chosen:** The notifier watches the waiting list and sends once for each card that appears in it, to every subscription, in the background: a send is started and forgotten, with a 15 second limit, and the hub's close aborts what is still out. What was already waiting when the hub started is not sent again. Nothing in the sending can throw into the code that held the command. The text is Chinese from the catalog and holds no command: the title 等你, the body 有一条命令等你确认, an icon, a tag that is the card's key so two cards never replace one another, and the address `/workbench?card=<key>`. The service worker shows what the hub sent and nothing of its own, and ignores anything that is not that shape. Opening the notification focuses an open window of the page and tells it to go to the address, or opens a window there; the page scrolls to the card and outlines it for a moment, or does nothing if the card has gone.
- **Why:** The notification appears on a lock screen, where a repository name or a command is a leak, and the same Chinese text then needs no translation step. The hub's sending must not be able to hold up or fail a hold.
- **Other options:** Retrying a failed send; naming the form of the hold in the notification; one notification replacing the last.

## 2026-11-17 — Service worker, manifest and icons

- **Chosen:** The worker is TypeScript in `packages/web/src/worker/`, built by Vite as a second entry to `dist/sw.js` with no imports, so it is a plain classic script. It shares no module with the page; its pure parts are tested. The hub serves it at `/sw.js` (never cached), the icons at `/icons/<name>` (images only) and a manifest at `/manifest.webmanifest` that it builds from the catalog, so the name is not literal text in a file. All of it is behind the front door and under the page's own policy, which is unchanged; the manifest link asks for credentials so that its request carries the Access cookie. The icons are the 中枢 mark of the prototype's `logos.html` and of the sidebar, in the accent colour: `icon-192.png`, `icon-512.png` (also the maskable one, full bleed with the mark inside the safe zone), `apple-touch-icon.png` at 180 pixels, and `mark.svg` for the tab. The PNGs were drawn from that mark by headless Chrome once and are committed as they are. The page declares `apple-mobile-web-app-capable` and a theme colour.
- **Why:** iPhone allows push only for a page on the home screen, which needs the manifest and a PNG touch icon. A worker with no imports works in every browser, with no need for module-worker support.
- **Other options:** A hand-written plain JavaScript worker in `public/`; a build step that draws the PNGs; a manifest file in `public/`.

## 2026-11-17 — The development harness gets holds and push

- **Chosen:** `tools/page-dev` starts with a pretend target `demo` that only prints the command it was given, so a command that is held and then confirmed there runs nothing. `/__harness/hold?kind=repo|branch|data|file|long|hidden` (or `?command=` and `?cwd=`) starts a command on it, which the lock holds like any other. The harness generates VAPID keys on the first start and keeps them in its data folder, so a browser's subscription survives a restart (`--push none` starts without). `/__harness/device/new` makes a pretend device with real keys and subscribes it through the hub's own route; the hub's push for it arrives at `/__harness/push/<id>` on the harness, which decrypts it, `/__harness/pushes` lists what arrived, and `/__harness/device/<id>/gone` makes that device answer 410. A real browser on this machine can subscribe too and gets a real push service's message.
- **Why:** The check should use the real routes and the real encryption without a phone, and a held command in a test harness must be unable to do harm.
- **Other options:** A harness that holds `gh repo delete` on the hub's own target; fake keys.

## 2026-11-17 — Child agents instead of child sessions from #7

- **Chosen:** From #7 on, each issue is implemented by a child agent started from the orchestrating session, in its own
  git worktree, on its own branch and pull request, with its model and effort chosen per issue as before.
- **Why:** The desktop app refused to start a new session on a turn that an automated event had started, and the owner
  asked for the work not to stop. A child agent keeps the same separation: no implementation in the orchestrating
  session, one branch and pull request per issue.
- **Other options:** Stop and wait for the owner to start each session by hand.

## 2026-11-17 — Deployment in two steps

- **Chosen:** #8 is done in two steps. A child agent builds the images, the Compose file and the deploy script, and
  rehearses them on the NAS as a separate Compose project, `superagent2`, under `/share/Container/superagent2`, without
  the tunnel and without touching any existing container. The orchestrating session then performs the take-over itself:
  it stops the first Super-agent's containers, which are kept with their volumes, and starts the tunnel of the new
  project.
- **Why:** The NAS runs the first Super-agent and a dozen unrelated services. The rehearsal proves the new system starts
  there before anything the owner relies on is stopped, and the one step that affects what is live is taken by the
  session that answers to the owner.
- **Other options:** One step by a child agent; leaving the deployment until every other issue is built.

## 2026-11-17 — Images for the hub and the brain

- **Chosen:** One `deploy/Dockerfile` with three stages on `node:24.14.1-bookworm-slim`, the Node version of this PC. The
  `build` stage installs the workspace with pnpm 12.18.0, builds the hub, the brain and the page with their workspace
  dependencies, and then installs again with `--prod` to drop development dependencies. The `hub` stage adds `bash`,
  `git`, `gh` 2.102.0 (the release tarball, the version on this PC), an SSH client, `curl`, `jq`, `rsync`, `sudo`,
  `procps`, `less`, `unzip` and `xz-utils`, and sets `gh auth git-credential` as Git's credential helper for
  `github.com`, so `git` uses the command's `GH_TOKEN`. The `brain` stage adds `git`, `ripgrep`, an SSH client and the
  three programs from npm at pinned versions: `@openai/codex@0.163.0`, `@anthropic-ai/claude-code@2.1.326` and
  `@deepseek-ai/dsh@0.2.1-rc.2`, with Claude Code's own updater turned off. Both images copy the whole built workspace.
  The base image is named by its exact version, which was not on the NAS, so no image already there is retagged.
- **Why:** One build stage shared by both images builds the code once. A pinned version tag keeps the build from moving
  a tag that other projects on the NAS use.
- **Other options:** One Dockerfile per image; `pnpm deploy` per package, which leaves out the `dist` folders because
  `.gitignore` lists them; the vendors' install scripts instead of npm; Alpine, which Claude Code and Codex support less
  well.

## 2026-11-17 — Who the containers run as

- **Chosen:** Both containers run as `node`, uid 1000, which is also `novanxu`'s uid on the NAS. The hub's `node` has
  passwordless `sudo`. Claude Code, Codex and `dsh` all run in full-access mode as a non-root user, so the brain has no
  `sudo` and does not need `IS_SANDBOX`.
- **Why:** The brain must read the token file the hub writes with mode 0600, and the hub must read the SSH key and write
  the project folder that the deploy script creates on the NAS as `novanxu`; one uid makes all three work without
  changing ownership. `sudo` in the hub keeps the brain able to install a tool there, so running as `node` does not
  harden the hub against operations.
- **Other options:** The hub as root, which needs the token file made readable for the brain some other way; the brain
  as root with `IS_SANDBOX=1`.

## 2026-11-17 — Volumes and the brain's token

- **Chosen:** Named volumes: `superagent2-hub-data` (the database), `superagent2-hub-home` (the hub's home folder, with
  `known_hosts` and any `gh` or `git` settings), `superagent2-brain-link` (the brain's token, written by the hub at
  `/var/lib/superagent2/link/brain.token` and mounted read-only in the brain), and one per program for the brain:
  `superagent2-brain-codex` (`~/.codex`), `superagent2-brain-claude` (`~/.claude`, with `CLAUDE_CONFIG_DIR` pointing
  there so `.claude.json` is kept too), `superagent2-brain-dsh` (`~/.dsh`) and `superagent2-brain-workspace`. Every
  container, volume and network has an explicit name starting with `superagent2`.
- **Why:** The hub makes the token at its first start, so a volume of its own lets the brain read it without seeing the
  hub's database. Claude Code finds a session by its working folder, so the workspace path and the session files must
  both survive a restart.
- **Other options:** Mounting the hub's data volume in the brain; the token in a secrets file written by the deploy
  script; one volume for the brain's whole home folder.

## 2026-11-17 — How the hub reaches the NAS host

- **Chosen:** The hub resolves `host.docker.internal` to Docker's host gateway (`extra_hosts: host-gateway`) and signs
  in as `novanxu@host.docker.internal` on port 22, where the NAS's `sshd` listens on every address and already allows
  `novanxu`. The key is `secrets/ssh/nas_ed25519`, generated on the NAS by the `secrets` step and mounted read-only. The
  `authorize` step adds the public key to `novanxu`'s own `~/.ssh/authorized_keys` with
  `from="10.0.0.0/8,172.16.0.0/12",no-agent-forwarding,no-X11-forwarding`, after copying the file to
  `/share/Container/superagent2/backups`; `deauthorize` removes it. The rehearsal ran `authorize`, because it changes no
  `sshd` setting and no other user's access.
- **Why:** The host gateway is the documented way for a container to reach its host and does not depend on the subnet
  Docker hands the project. Limiting the key to Docker's private ranges means a copy of it is useless from the LAN or
  Tailscale.
- **Other options:** The project network's own gateway address, which changes if the network is recreated; host
  networking for the hub; a key without a source restriction; an `sshd` setting such as `AllowUsers`, which would
  change SSH for everyone.

## 2026-11-17 — Project folders and credential paths in the deployment

- **Chosen:** `HUB_PROJECT_FOLDERS=/share/Container/superagent2/projects`, a folder on the NAS mounted at the same
  path inside the hub, so one path means the same folder on the `hub` and `nas` targets. `HUB_CREDENTIAL_PATHS` names
  the new secrets folder and the first Super-agent's (`/share/Container/superagent2/secrets`,
  `/share/Container/superagent/secrets`, each also with `/**`), the token volume's folder `/var/lib/superagent2/link/**`
  and the mounted key's folder `/run/superagent2/ssh/**`.
- **Why:** A folder that exists on both targets at one path keeps the lock's view of a path true whichever target runs
  the command. Naming the old secrets folder keeps it protected while it is the way back.
- **Other options:** A named volume for projects, which the `nas` target could not see; also listing the brain's
  workspace, which lives in another container.

## 2026-11-17 — The deploy script

- **Chosen:** `deploy/deploy.sh`, run on the NAS with bash 3.2 (QNAP's), installed by its own `source` step as
  `/share/Container/superagent2/deploy.sh`. A commit reaches the NAS as `incoming/<commit>.tar` made by `git archive`;
  `source` unpacks it into `src.new` and swaps it in, keeping the old tree as `src.previous`. `build` keeps the replaced
  images as `superagent2-hub:previous` and `superagent2-brain:previous` and tags new ones with the commit; `rollback`
  swaps both back. The other steps are `secrets`, `codex-login`, `up`, `health`, `authorize`, `deauthorize`, `stop`,
  `status`, `release` (source, build, up, health), `takeover` and `giveback`. Every path it deletes or moves is checked
  to be under `/share/Container/superagent2`, every image it tags to be a `superagent2` name, and every Compose call
  carries `-p superagent2` and the file; the only commands naming other containers are the `docker stop` and
  `docker start` of `superagent-tunnel`, `superagent-brain` and `superagent-hub` in `takeover` and `giveback`. The
  Docker client's settings go in `/share/Container/superagent2/.docker`, because Container Station's client otherwise
  tries to create a folder `novanxu` may not write. The hub is published on `127.0.0.1:18180`, a port nothing on the
  NAS uses.
- **Why:** The NAS has no `git`, so an archive is what can reach it; keeping one previous tree and image is enough to go
  back from a bad deployment. Health is checked from the hub's `/health` and from the brain's own last link message,
  since the brain's link state is otherwise only visible behind the front door.
- **Other options:** Cloning on the NAS; a symbolic link `src` to a folder per release; keeping every release.

## 2026-11-17 — Copying credentials from the first Super-agent

- **Chosen:** The `secrets` step copies whole `NAME=value` lines, selected by name, from the first file in a fixed list
  that has a non-empty value: the hub's values from `hub.env` (then `access.env` or `cloudflare.env`) and `github.env`,
  `CLOUDFLARE_API_TOKEN` from `cloudflare.env`, `BRAIN_CLAUDE_OAUTH_TOKEN` from `brain.env` and `TUNNEL_TOKEN` from
  `tunnel.env`, into `hub.env`, `brain.env` and `tunnel.env` of mode 600 in a folder of mode 700. Nothing is printed but
  names. A file that exists is kept, so a later run never overwrites a value changed by hand. The VAPID keys are reused,
  as the design's table says. `codex-login` copies only `auth.json` from `superagent-brain-codex-home`, through a
  one-off container of the brain service that mounts the old volume read-only, and keeps an `auth.json` already there.
- **Why:** The old Codex volume also holds the old system's sessions, databases and files of its own, which the new
  brain should not inherit. Copying lines keeps the quoting Compose already reads.
- **Other options:** Copying the whole Codex volume; reading values from the old containers' environment; overwriting
  the new files on every run.

## 2026-11-17 — What the rehearsal exercised

- **Chosen:** The conversation turn through the brain link was run against a second hub process started for the
  rehearsal inside `superagent2-hub`, on port 8181 with its database in `/tmp` and an Access key made for the occasion,
  linked to a second brain process inside `superagent2-brain` that used the container's programs, logins and network,
  with `BRAIN_PROVIDERS=claude`. The script stayed outside the repository and both processes were stopped afterwards.
  Codex's login was checked with `codex login status` only, and no Codex turn was run.
- **Why:** The deployed hub admits only an assertion signed by Cloudflare for the owner, which cannot be made before the
  take-over, and must gain no bypass. The ChatGPT login is shared with the first Super-agent's running brain, and a
  refresh by the new brain could sign the old one out while the owner is away.
- **Other options:** A development flag in the hub; skipping the conversation turn; running a Codex turn.

## 2026-11-17 — The take-over waits for the owner

- **Chosen:** The take-over of the host name is not run yet. Everything for it is in place and rehearsed: one command on
  the NAS, `bash /share/Container/superagent2/deploy.sh takeover`, and its reverse, `giveback`. #8 stays open until it
  has run. The remaining issues are built meanwhile; what they need from a live deployment is verified after it.
- **Why:** Just before the take-over, the first Super-agent held four tickets queued within the last hour on other
  projects, and one awaiting merge. Stopping its hub would drop work the owner had just started there. The owner asked
  for the take-over on the understanding that the first Super-agent was no longer in use; what was found does not match
  that, so the step that cannot be taken back quietly is left for the owner's word.
- **Other options:** Take over at once, as the issue says, and lose the queued tickets; wait for the queue to empty and
  take over then, without knowing whether the owner will queue more.

## 2026-11-17 — The take-over was run on the owner's word

- **Chosen:** After the owner said to take over, `deploy.sh takeover` was run on the NAS at 14:05 UTC. The first
  Super-agent's hub, brain and tunnel are stopped and kept; its four queued tickets and the one awaiting merge were not
  carried over. #8 stays open until the owner has signed in to the page and talked to the brain from a phone, which only
  the owner can do.
- **Why:** The owner decided, knowing about the queued tickets. What could be checked without the owner's sign-in was
  checked: the new tunnel registered its connections, the host name redirects to the Cloudflare Access sign-in, a path
  that Access lets through is answered by the new hub with its own refusal, the hub is healthy and the brain is linked.
- **Other options:** Close #8 on those checks alone.

## 2026-11-17 — How a runner passes the front door

- **Chosen:** A runner opens a WebSocket at `/runner/link` through the front door with three headers:
  `CF-Access-Client-Id` and `CF-Access-Client-Secret`, which Cloudflare Access turns into the signed assertion the hub
  already verifies (a `service` identity), and `x-runner-token`, its own runner token. The hub admits the connection only
  when the assertion is a service token, the runner token belongs to a machine that is not revoked, and the assertion's
  `common_name` equals the Access client id recorded for that machine. Every other path still refuses a service identity,
  with or without a runner token, and plain HTTP on `/runner/` answers 403. A runner can do nothing on the link but say
  hello, report and answer the commands it is sent. The Access application must have a Service Auth policy that lets the
  machines' service tokens through; that is set in Cloudflare by the owner and was not changed here.
- **Why:** Two independent secrets are needed, and binding the runner token to its own service token means a leaked
  runner token is useless with another machine's service token. A header of our own keeps the runner token out of
  `Authorization`, which Access can be configured to read.
- **Other options:** The runner token alone with any service token; the runner token in `Authorization`; a separate
  host name for runners.

## 2026-11-17 — Adding and revoking a machine

- **Chosen:** Migration 6 adds a `machines` table: the name, the SHA-256 of the runner token (never the token), the Access
  client id and, when the hub made it, the service token's id, the time it was added and revoked, when it was last seen,
  and its last report. The hub's command line is `node packages/hub/dist/machines-cli.js add <name> | revoke <name> | list`
  with `HUB_DATA_DIR` (in the container: `docker exec superagent2-hub node packages/hub/dist/machines-cli.js …`). `add`
  creates an Access service token named `superagent2-runner-<name>` through Cloudflare's API
  (`POST /accounts/<CLOUDFLARE_ACCOUNT_ID>/access/service_tokens` with `CLOUDFLARE_ACCESS_API_TOKEN`), or reuses one with
  `--access-client-id`, and prints once a line `superagent2-runner-setup:<base64url JSON>` holding the hub's address
  (`--hub` or `HUB_PUBLIC_URL`), the name, the client id and secret and the runner token. A machine name is lower-case
  letters, digits and dashes, and not `hub` or `nas`. `revoke` marks the machine revoked; a running hub sees the change
  through SQLite's `data_version` once a second and closes that runner's connection with code 4003, and a revoked token is
  refused at the next connection. Adding a revoked name again issues a new token. The Cloudflare call is behind an
  interface with a fake in the tests; it has not been made against the real API. The token is created with Cloudflare's
  default lifetime, and `revoke` does not delete it in Cloudflare.
- **Why:** The owner or the brain adds a machine once, by hand; the printed line is the one thing to carry to the machine.
  Polling the database is how a second process tells the running hub, without a control endpoint. Run through the
  command channel, `add`'s output would be stored with the command, so it is meant to be run in a terminal.
- **Other options:** An admin endpoint on the hub; writing the machine's file directly; deleting the service token on
  revoke, which is a credential deletion the lock would hold anyway; a token lifetime of our own choosing.

## 2026-11-17 — The runner on a machine

- **Chosen:** `packages/runner` runs as `node packages/runner/dist/main.js <setup|install|uninstall|run|status|programs>`
  from a checkout of the repository built with `pnpm build`. Its files are in `~/.superagent2` (or
  `SUPERAGENT2_RUNNER_HOME`): `runner.env` with `SUPERAGENT2_HUB`, `MACHINE_NAME`, `ACCESS_CLIENT_ID`,
  `ACCESS_CLIENT_SECRET`, `RUNNER_TOKEN`, and optionally `RUNNER_SLOTS` and `RUNNER_MODELS_<PROGRAM>`; `runner.log`;
  `supervisor.pid`; and `running.json`. `setup` reads the hub's line from standard input (and the client secret when the
  line has none), never from the command line, and writes `runner.env` readable only by the user: mode 0600 on macOS,
  and on Windows `icacls /inheritance:r /grant:r <user>:F`. This replaces the design's `~/.superagent/runner.env`, which
  is the first Super-agent's folder.
- **Why:** A checkout is what a work machine already has, and the folder of its own keeps the first Super-agent's
  installed runner untouched.
- **Other options:** A packaged copy of the runner in `~/.superagent2/app`; the settings in the system's credential store.

## 2026-11-17 — Commands on a runner, and when the connection is lost

- **Chosen:** A runner is one more target behind the target interface, found by its machine name, so the brain's
  `run_command`, the page and the lock reach it unchanged; the target list the tools describe includes each machine with
  its system and whether it is online. The hub sends `run` with the command, folder and the same credentials as on the
  other targets; the runner runs it through Node's platform shell (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` on
  macOS) as the machine's user, with no sandbox, sends the output as base64 chunks and `ended` or `failed`, and on `stop`
  kills the whole tree (`taskkill /T /F`, or `SIGKILL` to the process group). When the link drops, for any reason, the
  runner kills every command it runs and the hub records them `interrupted` with the reason that the connection to the
  machine was lost; when the hub closes they are recorded with the hub's own reason. A runner that died with commands
  running stops their trees at its next start, from the process ids it keeps in `running.json`, if the machine has not
  restarted since. A machine that is registered but offline fails the command at once. The hub pings each runner every 15
  seconds and drops one that misses a pong; a runner that hears nothing for 60 seconds drops the connection. A runner
  reconnects after 1, 2, 4 … up to 30 seconds, and waits longer after a revocation. A second connection of the same
  machine replaces the first. `GET /api/machines` lists the machines for the owner.
- **Why:** Reattaching to commands across a dropped connection would need output buffered on the machine and a way to
  tell the hub what happened while it could not hear; killing them makes "interrupted" true, which is the same rule the
  NAS target follows.
- **Other options:** Keeping commands running across a drop and reattaching; holding a command until its machine comes
  online.

## 2026-11-17 — What a runner reports about its programs

- **Chosen:** The runner reports its host name, system, release, architecture, user and slots, and for each of `codex`,
  `claude`, `dsh` and `agy` (Antigravity) whether it is on the path, its version (`--version`) and its models with their
  efforts, each with where the list came from. Codex: `codex debug models`, keeping models whose `visibility` is `list`,
  with their `supported_reasoning_levels`. Claude Code: an `initialize` control request to
  `claude -p --input-format stream-json --output-format stream-json --verbose`, whose answer lists the models with
  `resolvedModel` and `supportedEffortLevels`; the process is stopped once it has answered, and no message is sent.
  Antigravity: `agy models`, where a trailing `-low`, `-medium`, `-high` and the like is read as an effort of the model
  before it (`gemini-3.8-flash-high` is `gemini-3.8-flash` at `high`), and the other models take the efforts its
  `--help` lists for `--effort`. dsh cannot say: its SDK profile has no listing method, and `initialize` checks the effort
  but accepts any model name, so its list comes from configuration, by default `deepseek-flash` with `off`, `low`, `high`
  and `max`, the efforts its `initialize` accepted on this PC. `RUNNER_MODELS_<PROGRAM>` (`model:effort|effort,…`)
  replaces any program's list. Programs are listed when the runner starts and every six hours, and the hub is sent a new
  report. Free slots equal `RUNNER_SLOTS` (default 2) until workers (#11) take them.
- **Why:** Found from each program's help and from experiments here with codex-cli 0.163.0, Claude Code 2.1.326,
  dsh 0.2.1-rc.2 and Antigravity 1.5.10; the design refuses a model or effort a machine does not offer, so the list
  should be the program's own wherever it can say.
- **Other options:** A fixed list per program in the hub; asking dsh's account API for its models directly.

## 2026-11-17 — Starting at login

- **Chosen:** Windows: `install` adds the value `SuperAgent2Runner` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  running `node main.js launch`, which starts a hidden, detached supervisor unless one is already running; the supervisor
  runs `main.js run`, restarts it 2 seconds after it exits, or up to a minute when it keeps exiting quickly, and appends its output
  to `runner.log`, rotated at 5 MB. macOS: `install` writes `~/Library/LaunchAgents/com.superagent2.runner.plist` with
  `RunAtLoad`, `KeepAlive`, the installing shell's `PATH` and the log, and loads it with `launchctl bootstrap gui/<uid>`.
  `uninstall` removes the Run value or unloads and deletes the launch agent and stops the runner; `--purge` also deletes
  the settings folder. Both refuse to install before `setup`.
- **Why:** Both start as the user at login without administrator rights. The Run key shows a console window for a moment
  at login; creating a scheduled task with a logon trigger can need elevation.
- **Other options:** A scheduled task; a Windows service, which would run as another user; a shortcut in the Startup
  folder.

## 2026-11-17 — Runners in the development harness

- **Chosen:** `tools/page-dev` signs a request that carries `CF-Access-Client-Id` and `CF-Access-Client-Secret` as a
  service token with that client id, as Cloudflare would, and drops both headers; `/__harness/hold` takes `target=` so a
  command can be started on a machine through the command service.
- **Why:** The runner is verified against the real front door check, without a bypass in the hub.
- **Other options:** A fake runner connection in the harness.

## 2026-11-17 — The ticket and its states

- **Chosen:** `packages/protocol/src/tickets.ts` defines the ticket: a number, the repository (none for `writing`), its
  issues in working order (each with its number, link, and a title and summary as `GeneratedText`), its own title and
  summary, kind, difficulty, platform, state, machine, engine (`codex`, `claude`, `dsh`, `antigravity`), model, effort,
  branch, pull request, guided round, the tickets it waits for, why it stopped, and the conversation it was filed in.
  Ticket numbers are integers counted by the hub. The allowed moves are one table, `ticketMoves`: pending to waiting,
  working or stopped; waiting to working or stopped; working to verifying, delivered or stopped; verifying to working,
  merged or stopped; merged, delivered and stopped are final. `statesOutsideKind` keeps a writing ticket out of
  verifying and merged, and code out of delivered. `canMoveTicket` is the only check, and the hub refuses any other
  move. Migration 7 adds `tickets`, `ticket_issues`, `ticket_waits` and `ticket_moves`, the last being every move with
  its time and optional reason. Machine, engine, model, effort, branch, pull request and round are columns nothing
  sets yet (#11, #24). Stopping only changes the state, stores the reason and calls `TicketWork.stop`, which does
  nothing until #11 gives it a worker to stop.
- **Why:** One table of moves is reviewable at a glance and testable exhaustively. A stopped ticket is final because
  #13's 改派 and #16's rounds act on a running ticket, and work after a stop is a new ticket for the same issue, which is
  allowed. Integers are short for the brain to say and for the owner to read.
- **Other options:** Letting a stopped ticket return to pending; random ids; one table with issues as JSON.

## 2026-11-17 — Filing an issue without filing it twice

- **Chosen:** `file_issue` runs `gh api` on the `hub` target through the command service, as the account that owns the
  repository (`novan-xu` or `nuofan-island`; another owner gets `novan-xu` unless `account` says otherwise). The body is
  written by the hub to a file in the system temporary folder and sent with `--input`, so no text of the issue passes
  through a shell's quoting on Linux or on Windows; the file is removed afterwards. Before creating, the hub records
  the filing under a hash of the repository, title and body (`issue_filings`, in migration 7), and records the issue's
  number when GitHub answers. A repeated call finds the record: with a number it reuses the issue; without one (the
  earlier attempt failed part-way) it lists the repository's issues updated since ten minutes before that attempt and
  reuses one with the same title and body before creating anything. Identical calls at the same moment share one
  attempt. A held command is reported as held, and the call can be repeated after the owner confirms. `open_ticket`
  makes a ticket for an issue that already exists, reading its English title from GitHub; it refuses a pull request
  or a closed issue, and returns the existing ticket for an issue that has one that has not stopped.
- **Why:** GitHub's issue list answers with `Cache-Control: s-maxage=60`; verifying on this PC, a list made just before
  the creation was served again seconds later without the new issue, and a second identical call filed a duplicate.
  The record in the hub does not depend on GitHub's caches, and the `since` address of the fallback is never requested
  before the creation it looks for.
- **Other options:** Searching GitHub before every creation; a marker in the issue body; calling GitHub's API from the
  hub with `fetch` instead of through the command channel.

## 2026-11-17 — Tickets for the brain and for the page

- **Chosen:** Five tools beside the command tools: `file_issue`, `open_ticket`, `list_tickets` (open by default, `all`
  for every ticket), `read_ticket` (with its moves) and `stop_ticket` (with an English and Chinese reason). They answer
  in English. The page reads `GET /api/tickets?scope=open|all&limit=` and `GET /api/tickets/<number>` (the ticket and
  its moves); `/ws` sends `tickets` with every open ticket after `hello`, and `ticket` whenever one changes. 工作台 lists
  the open tickets under 等你, newest first, each as one row with its state, Chinese title, repository and kind, in the
  prototype's `lrow` style, and drops a ticket when it finishes. Rows do not open anything until #13.
- **Why:** The same shape as the waiting list and the conversations, so #13 can build on it. Sending one ticket per
  change keeps a finished ticket's update reaching a page that shows it.
- **Other options:** The whole list on every change; a separate 工单 view now.

## 2026-11-17 — How an arrangement names its chains

- **Chosen:** `arrange_chains` takes a list of chains, each with a name, its repository, its issue numbers in working
  order, and `after`: names of other chains in the same call, or ticket numbers (a started ticket may be named, which
  is how later work follows a closed chain). `after_deployment` makes every wait of that chain also wait for the
  brain's `report_deployment` on the ticket before it. Every issue named must be on a pending ticket, and every issue
  of a pending ticket the call touches must be named. A chain keeps the number of the pending ticket whose issues
  equal its own, otherwise the lowest-numbered ticket it takes issues from, otherwise it gets a new ticket. A ticket
  whose issues all went to other chains is moved to stopped with the reason that it joined ticket N; what waited for
  it now waits for the chains that took its issues. A chain of several issues needs its own title and summary; its
  difficulty is the highest of its tickets'; two different platforms on one chain are refused. The whole result is
  checked for a cycle over every open ticket before anything is written, and the writes are one SQLite transaction,
  so a refused arrangement changes nothing.
- **Why:** Issues are what the brain knows and what it splits or joins when the owner asks for another arrangement;
  ticket numbers alone could not split a chain. Keeping a number where the chain is unchanged keeps the owner's card
  the same. Stopping a joined ticket instead of deleting it keeps its history, and a pending ticket has no work to stop.
- **Other options:** Chains named by ticket numbers only; deleting joined tickets; an arrangement that must cover every
  pending ticket at once.

## 2026-11-17 — Starting a chain only from the owner's own page

- **Chosen:** `POST /api/chains/start` with `{ chains: [{ ticket, fingerprint }] }`. The route refuses a request
  without a same-origin `Origin` (or with `Sec-Fetch-Site` other than `same-origin`) with 403, one that is not JSON
  with 415, and a malformed body with 400. The start itself is `ChainStarter.start`, which takes the raw Access
  assertion and verifies again that it is a `person` identity with the owner's email, as the lock's release does; the
  brain's tools are given only `ChainArranger` (arrange, report a deployment, let a waiting ticket proceed), which has
  no way to move a pending ticket. The fingerprint is a SHA-256 over the chain and every pending ticket arranged
  after it (ids, repository, kind, difficulty, platform, titles, issues and waits), computed by the hub for each card;
  a start whose fingerprint differs from the current one, that names a ticket no longer pending, or that would leave a
  pending ticket before one it starts unstarted, is refused with 409 and starts nothing. The moves are one
  transaction, so of two identical starts from two devices one succeeds and the other gets 409.
- **Why:** The same structure as the confirmation lock: what starts work is something only the owner's browser can
  produce, so no brain token, service token or tool reaches it. A fingerprint rather than a global version number
  keeps a start from being refused because an unrelated issue was filed meanwhile.
- **Other options:** One arrangement version for everything; a confirmation step on the card; letting the brain start
  a chain after the owner said so in the conversation.

## 2026-11-17 — What a start does, and when a waiting ticket begins

- **Chosen:** 开始 on a card starts that chain and every pending chain whose pending predecessors are all in the same
  start (`arrangedAfter` in `packages/protocol/src/chains.ts`); 全部开始 sends every card shown. Each started ticket
  whose waits are all met moves to working; the rest move to waiting. A wait is met when the ticket before it is
  merged, and, for a deployment wait, also reported deployed; a waived wait is met. Moving to working writes a row in
  `ticket_begins` in the same transaction; `TicketWork.begin` is called after the commit and the row is marked done,
  or failed with the reason, which `read_ticket` shows and the brain is told in the ticket's conversation (or the
  newest one); the ticket stays working. At the hub's start, rows neither done nor failed are begun again, and every
  waiting ticket whose waits are met begins, so a merge the hub did not see is not lost. Merging is not built here:
  the chain service listens to ticket changes, so the move to merged that #15 will make begins what waits. When a
  ticket stops while another waits for it (or is pending and arranged after it), the brain is told and decides:
  `proceed_ticket` waives the waits on stopped tickets, `stop_ticket` stops the waiting one. The brain cannot proceed
  a pending ticket.
- **Why:** Writing the begin in the same transaction as the move means a restart in between cannot lose it; calling
  the hook again after a restart is safer than not calling it, and #11 owns making a second call harmless. Keeping a
  ticket whose begin failed, rather than stopping it, leaves the decision to the brain, as the issue asks.
- **Other options:** Moving a ticket whose begin failed to stopped; a retry tool for the brain; beginning work from the
  merge code of #15.

## 2026-11-17 — Start cards and their notice

- **Chosen:** Every pending ticket is a `start` card in the waiting list, so it counts in 等你. Its `before` lists the
  waits not yet met, with their Chinese titles and states, and `startable` is false while something pending is before
  it. 工作台 shows the cards under 可以开始 (nothing before) and 之后 (grouped under what they wait for, with a thin
  rule), in ticket order, below the held commands. A card shows its repository, kind and the chain's issues in order by
  their Chinese titles with their numbers, and 开始 when it is startable; 全部开始 appears beside the first heading when
  there is more than one card. Pending tickets are left out of the ticket list below, since they are cards. Web Push
  sends one notice, tagged `start`, when one or more chains become ready to start together; chains that still wait
  send none.
- **Why:** The design lists a chain to start among what waits for the owner. One notice per batch matches how the
  brain files several issues at once; the shared tag lets a device replace the previous notice.
- **Other options:** A separate count for chains; a notice per chain; showing pending tickets twice.

## 2026-11-17 — Where the allowance is read, and how

- **Chosen:** Each runner reads what is left on the subscriptions logged in on its machine, when it starts (after
  listing its programs) and every ten minutes, and sends the readings with its report (`allowances` in
  `MachineReport`). Codex: `codex app-server`, `initialize`, then the request `account/rateLimits/read`, whose answer
  gives each window's `usedPercent` and `resetsAt`, `rateLimitReachedType` and `ordinaryUsageAllowed` (found with
  `codex app-server generate-json-schema` and tried on this PC). Claude Code: the control request `get_usage` to
  `claude -p --input-format stream-json --output-format stream-json --verbose` after `initialize`, whose answer gives
  `rate_limits.limits` (kind, percent, reset time, and a scope for limits of one model) and the five-hour and seven-day
  windows with `locked_reason` (the subtype was found among the control requests the program accepts and tried on this
  PC); no message is sent and the process is stopped once it has answered. What is left is 100 minus the most used
  general window; a full window, a reached limit, a lock, or ordinary usage not allowed makes it used up. Limits scoped
  to one model are left out. dsh and Antigravity are not read: neither has a way to say what is left (dsh's help and
  profiles have no usage or balance command, Antigravity's help has none), and neither is part of the engine choice.
  A reading that fails is reported as unknown with the reason. `node packages/runner/dist/main.js allowance` prints
  the readings.
- **Why:** Workers run on the runners with each machine's own logins, so the machine is where the reading means
  something. Both programs say it themselves through the same channels the brain already drives.
- **Other options:** Reading in the brain's container, whose logins are not the workers'; calling the vendors' usage
  APIs directly with the programs' tokens; learning the allowance only from the error when a worker hits a limit.

## 2026-11-17 — When a subscription counts as used up

- **Chosen:** The hub takes, for each of `codex` and `claude`, the newest reading among every machine's report that is
  not unknown, not older than 30 minutes by the hub's clock, and not a used-up reading whose reset time has passed.
  Without one the subscription is unknown, and unknown is not used up. `dsh` becomes the default engine only when both
  are used up by such a reading. `GET /api/allowance` lists both for #21, and the brain's `read_allowance` tool says the
  same with the machines online, their systems, programs and free slots.
- **Why:** The issue asks that an unknown or stale reading never counts as used up. Thirty minutes is three of a
  runner's reading intervals. Machines normally share the owner's two accounts, so the newest reading speaks for the
  subscription.
- **Other options:** Per-machine engine choice from each machine's own reading; any machine's used-up reading winning;
  no age limit.

## 2026-11-17 — How a chain's defaults are stated and resolved

- **Chosen:** The brain states, with the tool `choose_defaults`, for each pending ticket: its kind, every issue with its
  difficulty (the chain takes the highest, `chainDifficulty`), a one-line reason as `GeneratedText`, its platform, and
  for code its engine, `codex` or `claude`; writing takes Antigravity. It is refused, changing nothing, when an issue is
  missing or extra, the engine is missing for code, or the reason has a line break. The ticket keeps them
  (`difficultyReason`, `brainEngine`; migration 9). The rest is not stored but resolved whenever a card is made, by
  `resolveStart` in `packages/protocol/src/defaults.ts`, from the stated values, the owner's changes, the table and the
  runners online: engine = the owner's, else Antigravity for writing, else `dsh` when both subscriptions are used up,
  else the brain's pick unless it is used up and the other is not; machine = the owner's, else the online runner fitting
  the platform that has the engine, most free slots first, then by name (a full machine is still chosen when it is the
  only one; #11 decides what a start on a full machine does); model and effort = the owner's, else the table's row.
  What cannot be resolved is listed as missing (`defaults`, `machine`, `engine`, `model`) and shown on the card. The
  card's fingerprint covers the resolved choice and the reason, so a card that changed, through the owner, a runner or
  the allowance, cannot be started from an older view. A start refuses with 409 `incomplete` when any chain it would
  start is incomplete, and otherwise writes each chain's machine, engine, model and effort with who chose each
  (`chosenBy`: `default` or `owner`) and when. An arrangement that changes a ticket's issues, kind, difficulty or
  platform forgets what was stated for it and the owner's changes.
- **Why:** Runners come and go and the allowance changes; resolving when shown keeps the card true, and storing at the
  start keeps the choice fixed for the ticket through its guided rounds. Per-issue difficulties make "the highest of
  its issues" the hub's rule rather than the brain's arithmetic.
- **Other options:** Resolving once at arrangement and storing it; the brain naming the machine and model; a chain-level
  difficulty only; adding the fields to `arrange_chains`.

## 2026-11-17 — The owner's changes on the card, and 改派

- **Chosen:** `POST /api/chains/choice` with `{ ticket, machine?, engine?, model?, effort? }` changes a pending ticket's
  card: a value sets the owner's choice, `null` returns that field to the default, a missing field stays. It has the
  start's checks: same origin, JSON, and `ChainStarter` verifying again that the assertion is the owner's. What the
  owner gives that the chosen machine's program does not offer (a machine not online, an engine not installed there, a
  model and effort not offered together) is refused with 422 `unsupported` and nothing is stored; a default the owner
  did not give that does not fit is shown as missing instead. `POST /api/tickets/<n>/reassign` with the same fields
  chooses again for a waiting, working or verifying ticket: fields not given take today's defaults, the whole choice
  must be complete and offered, it is written with who chose each, and `TicketWork.reassign` is called for #11 to restart
  the worker; #13 puts the control on it. `Ticket.ran` holds what actually ran, written by #11 through `writes.ran`.
  `GET /api/engine-table` reads the table and `PUT` replaces it, with the same checks; it is kept as JSON under
  `engine_table` in a `hub_settings` table, starting from the design's values, and a change applies to every card not
  yet started.
- **Why:** One route per action, shaped like the start, so only the owner's page can change what a worker runs with.
  Refusing only what the owner gave avoids a dead end where changing the engine is refused because the table's model
  for it is not offered; the card then says the model is missing and the owner picks one.
- **Other options:** Storing an unsupported choice and refusing only at the start; one route for every change of a
  ticket; the table in the configuration file.

## 2026-11-17 — The choice on the start card

- **Chosen:** A start card shows the chain's difficulty and platform as chips, the Chinese reason, and three selects in
  the prototype's `wcard-where` row: 机器 (the online runners fitting the platform), 引擎 (the programs on the chosen
  machine) and 模型和推理强度 (each model with each of its efforts, as `model · effort`). A field the owner set has the
  accent border. What is missing is listed under it, and 开始 appears only when the choice is complete and nothing
  pending is before it. Changing the engine returns the model to the table's; changing the machine drops an owner's
  engine or model the new machine does not offer. The cards carry the machines (`StartCard.machines`) so the selects
  update with the runners.
- **Why:** The prototype has separate model and effort selects; offering only pairs a machine offers means the page
  never sends a model with an effort it does not have, which the hub would refuse.
- **Other options:** Four selects as in the prototype; an edit form behind a button.

## 2026-11-17 — Forcing the allowance in the development harness

- **Chosen:** `tools/page-dev` passes the hub an adjustment of the subscriptions it read, and
  `/__harness/allowance?codex=exhausted&claude=exhausted` (or `available`, `unknown`, `read` to use the runners' real
  readings again) sets it.
- **Why:** A used-up subscription cannot be produced on demand, and the hub's own rule is what needs seeing.
- **Other options:** A runner setting that replaces its readings.

## 2026-11-17 — One package of program adapters for the brain and the workers

- **Chosen:** The adapters for Codex, Claude Code and `dsh` (`ProgramAdapter`, the three programs, the line process, the
  JSON-RPC client and the clock) moved from `packages/brain` into an eighth workspace package, `packages/programs`
  (`@super-agent2/programs`), with their tests and fake programs. The brain re-exports it and behaves as before. What
  workers need was added as options the brain does not set: `tools` may be `null` (no hub MCP server: Codex gets no
  `mcp_servers.hub`, Claude Code gets `--mcp-config {"mcpServers":{}} --strict-mcp-config`, `dsh` gets a patch that only
  turns off the session log upload), `client` names the Codex client, `codexConfig` adds Codex configuration,
  `processTree` starts the program in its own process group and stops it with its whole tree (`taskkill /T /F`, or
  `SIGKILL` to the group and every descendant found with `ps`), and a handle may report its process id. A new event,
  `model`, carries the model and effort the program says it runs: Codex's `thread/start` and `thread/resume` answers,
  Claude Code's `init` message (its model only); the brain ignores it. A program given as an npm `.cmd` shim on Windows is
  run as Node with the shim's script, since `spawn` cannot run a `.cmd` without a shell.
- **Why:** The issue asks to share the code rather than write it twice. A package of its own keeps the runner from
  depending on the brain's conversation code.
- **Other options:** The runner depending on `@super-agent2/brain`; moving the adapters into `protocol`; a copy in the
  runner.

## 2026-11-17 — Where a worker works on a runner

- **Chosen:** A runner keeps one clone per repository at `~/.superagent2/repos/<owner>/<name>` (`git clone
  --no-checkout`, then `git fetch --prune` before each start), one worktree per ticket at
  `~/.superagent2/worktrees/<name>-t<ticket>`, and the ticket's own files at `~/.superagent2/work/t<ticket>`
  (`work.json` without any credential, the numbered events of the attempt, and the hand-back file). Preparing and
  removing are serialised per clone, so two tickets of one repository never run Git on the clone at the same time; each
  works only in its own worktree on its own branch. The branch is `sa2/ticket-<n>-<four hex digits>`, chosen by the hub
  at the first start and kept on the ticket, so every later attempt, a reassignment and the rounds of #16 use the same
  branch. A worktree is made from the branch when it exists locally or on `origin`, and otherwise from the default
  branch, read from `origin/HEAD`. It is removed, with its local branch, when the ticket is merged, delivered or stopped;
  the branch on GitHub stays with the pull request. The runner's free slots are its `RUNNER_SLOTS` minus the workers it
  is running, reported whenever that changes; the hub also counts the workers it has started on a machine and starts no
  more than the machine's slots, so a start on a full or offline machine waits in a queue until a slot is free.
- **Why:** One clone per repository makes a second ticket cheap to start. The random part of the branch name keeps a hub
  whose database was replaced from reusing an old branch of the same number.
- **Other options:** A fresh clone per ticket; a branch named after the issue; refusing a start on a full machine.

## 2026-11-17 — How a worker hands back its result

- **Chosen:** The worker writes a JSON file at a path outside its worktree that its task names:
  `{"pullRequest": <number>, "summary": {"en": …, "zh": …}}`, the summary being `GeneratedText`. When the worker's turn
  ends, the runner reads the file (a UTF-8 byte order mark is ignored), and reads the pull request with
  `gh pr view --json number,url,state,headRefName,closingIssuesReferences`; it is accepted when it is open (or already
  merged), comes from the ticket's branch, and closes every issue of the chain. Otherwise the runner tells the worker in
  a new turn exactly what is missing (recorded on the ticket as a message from the hub), at most twice; after that the
  attempt fails as `no-pull-request` with the last problem. Nothing reads the worker's prose.
- **Why:** The issue asks for a definite way to hand back that does not depend on parsing prose. A file needs no server
  on the runner and works the same for the three programs; GitHub's own record of the pull request is what is checked.
  The checks are facts about the pull request, not a judgement of the work, so this adds no review step.
- **Other options:** An MCP tool served by the runner; a marker line in the worker's last message; finding the pull
  request by branch without a hand-back.

## 2026-11-17 — The worker's GitHub identity

- **Chosen:** The hub sends the token of the account that owns the repository (`novan-xu` or `nuofan-island`, as for
  filing) with each start over the runner's link; the runner keeps it in memory only and gives it to the worker's
  program in its environment as `GH_TOKEN`, `GITHUB_TOKEN` and `SUPERAGENT2_GITHUB_AUTH`. A `gh` shim in
  `~/.superagent2/bin`, first on the worker's `PATH`, sets `GH_TOKEN` from `SUPERAGENT2_GITHUB_AUTH` when it is missing
  and runs the real `gh`. Git gets the token through `GIT_CONFIG_PARAMETERS`, which empties `credential.helper` and sets
  a helper for `https://github.com` that prints `SUPERAGENT2_GITHUB_AUTH` as the password, so the machine's own
  credential manager and `gh` login are not used. Codex is told to pass the whole environment to its commands
  (`shell_environment_policy.inherit = all`, `ignore_default_excludes = true`). Commits are authored as the account,
  with its name and `<id>+<login>@users.noreply.github.com`, read once per account with `gh api user`. The token never
  appears in a command line, the runner's files, its log or the events sent to the hub.
- **Why:** On this PC `dsh` removed every variable whose name contains `KEY`, `PASSWORD`, `SECRET` or `TOKEN` from its
  shells, with no setting to keep one, so `GH_TOKEN` and `GIT_CONFIG_KEY_<n>` never reached it; its worker then fell
  back to the machine's own `gh` login. A variable named without those words survives, and one mechanism serves all
  three programs.
- **Other options:** A `gh` configuration folder holding the token, which stores it on disk; `GIT_CONFIG_COUNT` with
  `GIT_CONFIG_KEY_<n>`, which `dsh` removes; leaving the commit author to the machine's Git settings.

## 2026-11-17 — Attempts, the worker's output, and what the page and the brain see

- **Chosen:** Migration 10 adds `ticket_attempts` (one row per worker started for a ticket: machine, engine, model,
  effort, state `queued`, `preparing`, `running`, `finished`, `failed`, `stopped` or `replaced`, the session, the failure
  and its reason, when its machine stopped being reachable, the last event number) and `ticket_work_events` (every event
  the runner sends, numbered per attempt and stored once), and the ticket's `report_en` and `report_zh`. `Ticket.work`
  is the latest attempt and `Ticket.report` the worker's report; `Ticket.ran` is written from the program's own report
  of its model and effort, or from what was asked when the program does not say (`dsh`, and Claude Code's effort).
  `GET /api/tickets/<n>/work?after=&limit=` lists the events; on `/ws` a page sends `watch.ticket` with an optional
  `after` and receives the stored events and then each new one as `work`, until `unwatch.ticket`.
  `POST /api/tickets/<n>/messages` with `{"text": …}` sends the owner's message to the running worker and
  `POST /api/tickets/<n>/stop` stops the ticket with the reason 你停止了它 / "The owner stopped it", both with the
  same-origin and JSON checks of the other owner actions. The brain gets `message_worker`, and `read_ticket` shows the
  worker's state and the end of its latest output.
- **Why:** #13 needs the timeline, the panel's state, the reply box and 停止, and they are built on these.
- **Other options:** Keeping only the last attempt; storing output as one growing text; sending every event to every
  page.

## 2026-11-17 — A second begin, restarts and lost connections

- **Chosen:** `TicketWork.begin` makes the first attempt only when the ticket has none, so a second call (a restart of
  the hub, a reconnecting runner) starts nothing new; a runner told to start an attempt it already runs or has ended
  does nothing. A runner whose link drops keeps its workers running and keeps every event in the attempt's file; its
  `hello` lists the work it holds (attempt, last event, whether it runs, whether it ended), and the hub answers with
  `work.sync` from the last event it stored, so the output and an outcome reached meanwhile catch up. The hub marks the
  running attempts of a machine `unreachableSince` when its link drops and every running attempt when the hub starts,
  and clears it at the machine's `hello`. A runner that restarted (its old worker trees are stopped from its process
  ledger at start) lists the work as not running, and the hub starts the same attempt again, which resumes the
  program's session in the same worktree with a note that the turn was cut off; a session the program reports lost is
  started afresh with the whole task and a note to continue from what is on the branch. A running attempt that the
  machine no longer lists fails as `lost`; a start the runner never received is sent again; work a runner holds for a
  ticket that ended, or that moved to another machine, is stopped and removed. Nothing is decided from how long
  anything took: a machine that never comes back leaves its attempt running and unreachable since a known time.
- **Why:** The issue asks for the truthful outcome in each case and forbids deciding from timing. Keeping workers alive
  across a dropped link is the outcome that loses nothing; the event files make "catches up" exact.
- **Other options:** Stopping workers when the link drops, as commands are; giving up on an attempt after a timeout.

## 2026-11-17 — A worker that fails, and the place left for the failure loop

- **Chosen:** An attempt fails as `prepare` (the worktree could not be made, or no token), `program` (the program
  exited, refused or ran out of allowance), `no-pull-request` (the hand-back was still wrong after two corrections) or
  `lost`. The hub records it with its reason, keeps the output, and tells the brain in the ticket's conversation with
  the end of the output, under the notice 工单 {ticket} 的执行没有完成，大脑会决定怎么处理. The ticket stays working,
  its `work` saying failed and that nothing runs. `WorkService.again(ticket, note)` starts a new attempt on the same
  branch with the ticket's current choice, resuming the session when the machine and engine are the same, and moves a
  verifying ticket back to working; nothing calls it yet. It is what #15 (a conflict back to the worker) and #16 (a
  guided round) call.
- **Why:** #16 owns the loop and its cap; a stopped ticket is final, so stopping on failure would close the door to it.
- **Other options:** Moving a failed ticket to stopped; a retry tool for the brain now.

## 2026-11-17 — Messages, stopping and reassigning

- **Chosen:** A message from the owner or the brain goes into the running turn when the program can take it (Codex,
  Claude Code) and is otherwise given as the worker's next turn (`dsh`, or between turns); either way it is recorded on
  the ticket with how it was delivered. Stopping a ticket stops its worker with its whole process tree and removes the
  worktree and the local branch; a machine that is offline does it when it is back. 改派 to the same machine starts a new
  attempt in the same worktree, resuming the session when the engine is the same, with a note naming the new choice. 改派
  to another machine first has the old machine commit what is uncommitted, push the branch and remove its worktree, and
  starts the new attempt only after that, from the branch on GitHub; when the old machine is offline the new attempt
  starts at once and the old work is discarded when that machine is back.
- **Why:** The issue asks that reassigning begin again on the same branch; pushing first is what carries unpushed work
  to another machine.
- **Other options:** Always starting fresh; discarding unpushed work on a move.

## 2026-11-17 — What a worker is told

- **Chosen:** `packages/runner/guidance/WORKER.md`, in English, is the worker's guidance: it knows only its issues and the
  repository, works through them in order, owns the result end to end (dependencies, tests, conflicts with the default
  branch, pushing), opens one pull request that lists and closes every issue, and hands back as above. The first
  message of a worker is that guidance followed by its task: the repository, folder, branch and its base, the chain's
  issues in order with their English titles and links, and the hand-back path. Nothing of the brain's guidance is in it.
- **Why:** The design gives the worker only its issues and the repository; a file outside the repository keeps it out of
  the worker's commits.
- **Other options:** Writing an `AGENTS.md` into the worktree; each program's own system prompt option.

## 2026-11-17 — Workers in the development harness, and what was verified

- **Chosen:** `tools/page-dev` takes `--credentials environment`, giving the hub `GITHUB_TOKEN_NOVAN_XU` and
  `GITHUB_TOKEN_NUOFAN_ISLAND` from its environment, and `/__harness/work?repository=&issues=&machine=&engine=&model=&effort=`
  opens tickets for existing issues, arranges them into one chain, states defaults through the brain's own tools,
  applies the owner's choice and starts the chain through `ChainStarter`, as the owner's page would. Verified on this PC
  with two local runners against `novan-xu/super-agent-sandbox`: one-issue tickets to pull requests with Codex
  (`gpt-6-luna`), Claude Code (`claude-haiku-5-5`) and `dsh` (`deepseek-flash`); a chain of three issues to one pull
  request closing all three; `npm install` and a push without a prompt; two tickets of the repository at once; an
  owner's message taken into a running turn; a stop that ended the worker's processes and removed its worktree; a hub
  killed and started again while a worker ran; a runner killed and started again while a worker ran; a reassignment to
  another machine and engine carrying the work over. The Mac mini could not be reached, so macOS is not verified.
- **Why:** The harness exercises the real front door, start and runner link without a bypass.
- **Other options:** Driving the brain's tools by hand over MCP for each check.

## 2026-11-17 — How Antigravity is driven

- **Chosen:** `packages/programs/src/antigravity.ts` runs `agy --input-format stream-json --output-format stream-json
  --model <model> --effort <effort> --disable-slash-commands [--conversation <id>] --print=` in the working folder, with
  one process per worker kept open: each message is one line `{"event":"user","message":{"content":"…"}}` on standard
  input and runs one turn, and each turn ends with a `result` event (`SUCCESS`, or `ERROR` with its text; a
  `finished_reason` of `interrupted`, `print_timeout` or `error` says why it ended early). All of this was found from
  `agy --help`, the changelog inside the program, and small runs here. The model is the id without its effort suffix
  (`gemini-3.8-flash`) and the effort is its own flag, which is what the runner's probe already reports. The `init`
  event gives the conversation id, which is the session; a resume passes `--conversation`, and because a conversation it
  cannot find is only a warning on standard error followed by a silent new conversation, the adapter compares the id in
  `init` with the one it asked for and reports a lost session when they differ. Text deltas, tool steps (`read_file`,
  `write_file`, `run_command`…) and the model in `init` become the adapter's events. Where Antigravity cannot do what the
  interface offers: a message cannot enter a running turn (it is read as the next turn), so `steer` answers `queued` and
  the runner sends it as the next turn; there is no interrupt command, so `interrupt` stops the process tree and the
  next message starts `agy` again on the same conversation; the effort it runs is not reported, so the model event
  carries none. A failure whose text names a quota, a rate limit, credits or a sign-in is `unavailable`, any other is
  `failed`. `--dangerously-skip-permissions` is not passed: in print mode the file and command tools ran without any
  prompt here, and a writing worker has no need for more. The adapter refuses the hub's tools.
- **Why:** The issue asks for a headless mode, the task and material in, the model and effort chosen, and a definite
  result. One long-lived process per worker gives a session of its own, corrections as further turns, and the same
  `ProgramAdapter` the other engines have.
- **Other options:** One `agy -p` run per turn with `--conversation`; `--json-schema` for the result; passing
  `--dangerously-skip-permissions` like the code engines.

## 2026-11-17 — A writing ticket's task and material

- **Chosen:** The brain opens one with `open_writing_ticket`: a title and summary with Chinese copies, the task in
  English, and `material`, a list of pieces each with a plain file name, where it comes from, and its text when the brain
  has it (verbatim; at most 20 pieces, 200000 characters each and 400000 together). It is stored beside the ticket
  (`ticket_writing`, migration 11) in the same step that opens it. It is a pending ticket of kind `writing` with no
  repository, no issue and no branch, and it shows as a start card like any other: the brain states its defaults with
  `choose_defaults` (kind `writing`; the difficulty may be left out and is then `standard`, since Antigravity's model
  does not depend on it), the hub resolves Antigravity, a machine that has `agy`, and the table's model and effort, and
  the owner starts it with 开始. The card shows the Chinese title and summary where a code chain shows its issues. The
  brain's guidance says to decide by purpose and substance, never by file type, and names README files, developer
  documentation and translating engineering documents as code work.
- **Why:** The issue says the brain opens it through a tool with the task, the material and where it comes from. The
  worker knows only that, so the brain is the way pasted material reaches it. Reusing `choose_defaults` and the card
  keeps one way to start work.
- **Other options:** Arranging writing tickets with `arrange_chains`; a second start route; a required difficulty.

## 2026-11-17 — The scratch folder and the hand-back of a writing worker

- **Chosen:** The runner makes `~/.superagent2/work/t<ticket>/scratch` with `input/` (each piece of text material written
  as a file; a piece without text is named in the task by its source, for the worker to fetch) and `output/`, runs the
  program there with no GitHub token in its environment, and briefs it with `guidance/WRITER.md` and its task. The
  worker hands back with a JSON file outside the scratch folder: `text` (the name of a UTF-8 file in `output/` that holds
  the result), `files` (names of other files in `output/`) and `summary` (`GeneratedText`). The runner checks it as it
  checks a pull request: the file is JSON of that shape, names something to deliver, every name is a regular file
  directly in `output/`, no more than 20 files, 4 MB each, 8 MB together, and a text of at most 200000 characters that is
  valid UTF-8 and not empty. Otherwise it tells the worker what is wrong in a new turn, at most twice, then the attempt
  fails as `no-pull-request` with the last problem. Nothing reads the worker's prose. A new attempt clears `output/` and
  the hand-back; the scratch folder is removed when the ticket is delivered or stopped.
- **Why:** A file for the result, rather than the text inside the JSON, spares the worker from escaping a long text. The
  definite checks are facts about the files, not a judgement of the work, so this adds no review.
- **Other options:** Asking for the whole result in `--json-schema` output; the text inside the hand-back JSON; leaving
  the checks to the hub.

## 2026-11-17 — Delivering the text and files into the conversation

- **Chosen:** The runner sends one new ending event, `delivered`, with the text, the files (name, size, media type and
  their bytes in base64) and the summary. The hub stores the files in `ticket_files` (a blob each), keeps the event
  without the bytes (so the page's socket and the event list never carry them), records the summary as the ticket's
  report, moves the ticket from working to `delivered`, and adds a `delivery` entry to the conversation the ticket was
  opened in (or the latest one): the ticket's Chinese title, the text, and the files. The page shows the text as written,
  in plain pre-wrapped text and not as Markdown, and each file as a download chip; `GET /api/tickets/<n>/files/<name>`
  serves a file to the owner only, always as an attachment with `Content-Security-Policy: sandbox`. The brain is told in
  the same entry (the text up to 20000 characters, the file names, the worker's note) so that it can answer in a line and
  open a new writing ticket if changes are wanted; another model that takes over gets it in the history. A failed writing
  worker is recorded with its output and the brain is told, as for code, and the ticket stays working. The runner removes
  the scratch folder when the ticket ends.
- **Why:** The conversation is where the owner asked, so the result belongs there. Files go through the link the runner
  already has, which is why they are limited in size.
- **Other options:** Streaming files over a separate HTTP upload from the runner; keeping the files on the machine and
  fetching them with a command; showing the text as Markdown.

## 2026-11-17 — Which engine may run which ticket

- **Chosen:** Antigravity is refused for code: the owner cannot choose it for a ticket of code work on the card or in 改派
  (422 `unsupported`), and the hub refuses to begin such a ticket. A writing ticket may be run by another engine if the
  owner chooses one, since the worker's brief and hand-back do not depend on the engine.
- **Why:** Antigravity's own tools are not what the code workers' brief assumes (git, pull requests), and nothing has
  tested it that way; writing with a code engine loses nothing.
- **Other options:** Allowing any engine for anything.

## 2026-11-17 — Where the brain is told to open writing tickets, and what was verified

- **Chosen:** The rule is in the brain's guidance: the "Writing work" section, a sentence under "Turning a need into
  issues" and a bullet under "How to act". `open_writing_ticket`'s description only says what the tool is for. (First the
  rule was also at the start of the tool description, because the real Claude Code was not reading the guidance at all;
  the cause is in the next entry, and with it fixed the tool description alone no longer needs the rule.) Verified on
  this PC with the
  development harness, one local runner (its home in a scratch folder; `agy` 1.5.10 logged in) and the real Claude Code as
  the brain: a translation opened as a writing ticket, started from its card on the page,
  run by `agy` with `gemini-3.8-flash` at high, and delivered into the conversation with the ticket delivered and no
  branch or pull request; a short email asked for in Chinese, which the brain opened as a writing ticket, stated the
  defaults of, and told the owner about, and which arrived in the conversation after 开始, with the brain noting what the
  worker had assumed; a worker that delivered a text and a file, the file downloaded from
  `/api/tickets/<n>/files/<name>`; a README rewrite of a repository, which the brain filed as an issue of kind
  `maintenance` (code work) and not as a writing ticket; and an `agy` run that failed with "No capacity available" (503),
  which was recorded with its reason on the ticket and told to the brain, and then retried from the card's reassignment.
  Not verified: macOS, and `agy` on a machine other than this PC.
- **Why:** The guidance has to be what tells the brain; the tool description should not carry rules the guidance owns.
  After the fix in the next entry the real Claude Code, with the tool description reduced to what the tool is for,
  opened a writing ticket for the Chinese email request and filed the README rewrite as an issue.
- **Other options:** Keeping the rule in the tool description as well; server instructions in the MCP handshake.

## 2026-11-17 — Where each program reads the brain's guidance

- **Chosen:** One source file, `packages/brain/guidance/AGENTS.md`. `prepareWorkspace` copies it into the workspace as
  `AGENTS.md` and writes `CLAUDE.md` there containing only `@AGENTS.md`. What each program reads, each checked live: Codex
  reads `AGENTS.md` from its working folder; Claude Code reads `CLAUDE.md` (and does not read `AGENTS.md` at all; a
  `CLAUDE.md` with `@AGENTS.md` imports the file); `dsh`'s `dsh-agent-instructions` plugin takes the first of
  `AGENTS.md` and `CLAUDE.md` it finds (its `instructionFileCandidates`, from `dsh --profile sdk
  --dump-config-schema`). The check, run through the real adapters and the real `prepareWorkspace`: a random code word
  was appended to the workspace's `AGENTS.md` at check time (never committed) and each program was asked, with no tool,
  for the code word in its standing instructions. Codex, `dsh` and Claude Code answered the code word; with no guidance
  files all three answered NONE; and with the old workspace, `AGENTS.md` alone, Claude Code answered NONE and `dsh`
  answered the code word. The brain on Claude therefore ran without any of its guidance from #5 until now; the earlier
  decision that said Claude Code reads `AGENTS.md` when there is no `CLAUDE.md` was wrong. A test now holds the two
  files in place.
- **Why:** `CLAUDE.md` with an import keeps one text; a second copy could drift, and `dsh` reading both files then
  reads one line more, which costs nothing. Starting Claude Code with `--append-system-prompt-file` would have changed
  the adapter that workers share.
- **Other options:** A second copy of the guidance as `CLAUDE.md`; a symbolic link; a system prompt option for Claude
  Code only. Workers are not affected: `guidance/WORKER.md` and `guidance/WRITER.md` are the first part of the
  worker's first prompt, not files a program is expected to find.

## 2026-11-17 — A rename over a file on Windows that fails with EPERM

- **Chosen:** `replaceFile` in the runner: the new content is written to a temporary file and renamed over the old file,
  as before, and when Windows refuses that rename with `EPERM`, `EBUSY` or `EACCES` the content is written into the
  existing file instead and the temporary file removed. It is used for the runner's settings file, its process ledger and
  each work's record. Any other error is still raised.
- **Why:** `setup.test.ts` failed now and then in the full run with `EPERM` on `runner.env.new` to `runner.env`. (The
  `works.test.ts` failure seen in review was not this: see the next entry.) On this PC a plain loop of write, read, write a
  temporary file, rename over the first failed with `EPERM` in about 1 of every 60 renames; a second rename straight
  after failed in most of those cases (something, most likely the scanner or indexer, keeps the freshly written file
  open for a while), and writing into the file never failed. So a wait or a retry would be a guess, and writing into
  the file is certain.
- **Other options:** Retrying the rename after a wait; writing the files in place always, which loses the atomic
  replacement where Windows allows it.

## 2026-11-17 — A worker never inherits the runner's credentials

- **Chosen:** The environment of every worker, code or writing, is built from the runner's own environment with these
  removed first (whatever the case of the name): `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN`, `SUPERAGENT2_GITHUB_AUTH`, the runner's own `RUNNER_TOKEN`, `ACCESS_CLIENT_ID` and
  `ACCESS_CLIENT_SECRET`, and `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` (which Git applies
  after the credential helper the runner sets and could replace it). A writing worker then has no GitHub token at all. A
  code worker has only what the hub sent for the repository's owner: `GH_TOKEN`, `GITHUB_TOKEN`,
  `SUPERAGENT2_GITHUB_AUTH` and the helper in `GIT_CONFIG_PARAMETERS`. The tests give the runner's environment a value
  for each of these, so they pass with or without `GH_TOKEN` and `GITHUB_TOKEN` set in the shell, and fail if one
  reaches a worker.
- **Why:** The `works.test.ts` failure in review was not a race and not the rename: a runner started from a shell
  holding `GH_TOKEN` handed it to a writing worker. For a code worker the hub's value already replaced the inherited
  `GH_TOKEN` and `GITHUB_TOKEN`, but the other variables `gh` and Git read were inherited.
- **Other options:** Removing only the two common names.

## 2026-11-17 — A ticket's address and what its detail reads

- **Chosen:** A ticket has its own address, `/tickets/<n>` (`ticketAddress` in `packages/protocol/src/page.ts`), which the
  hub serves as the page like every other route, so a link, a notification or a reload lands on the same ticket; 工作台
  stays marked in the navigation while it is open, and the detail's back link returns to 工作台. `GET /api/tickets/<n>`
  now also gives `attempts`, every attempt of the ticket (machine, engine, model, effort, state, failure and reason), so
  the timeline can name each worker, including those replaced by 改派. The page reads the ticket and pages through
  `GET /api/tickets/<n>/work` until a page comes back empty, then sends `watch.ticket` from the last event it holds; after
  a reconnection it watches again from there and pages again. Events are kept by their id, once each and in id order,
  whichever way they came; a late older event rebuilds the fold. Live events are gathered for 40 ms and applied as one
  change of the page. A `ticket` message for the open ticket whose state is not its last move reads the moves again.
- **Why:** The watch replays at most 5000 events, which a long worker exceeds; paging first and watching from the end
  loses nothing and does not render thousands of messages one by one. A timer rather than an animation frame because a
  background tab never runs animation frames, and the output then piled up unseen (found while verifying).
- **Other options:** `/workbench/tickets/<n>`; watching from 0 and relying on the replay; deriving earlier attempts
  from the English phase lines; flushing on every message.

## 2026-11-17 — What 工作台 says about each ticket

- **Chosen:** Open tickets are grouped by repository in name order, writing tickets last under 写作; pending tickets stay
  start cards. A row is a link to the ticket and shows a state that describes the worker, not only the ticket: 等前序
  (with the titles of what it still waits for), 没能开始 (the hub's begin failure as recorded), 还没开始执行, 排队中 (the
  machine it waits for), 准备中, 进行中, 联系不上 (since when, and which machine), 执行失败 (the failure in Chinese and the
  hub's reason as written), 没有在执行, 验证中, then the final states. Only 准备中 and 进行中 pulse; 验证中 does not, since
  nothing verifies until #15. The derivations are `packages/web/src/live/phase.ts` with tests; reasons the hub recorded
  in English are shown as raw text in monospace, as the design does for logs.
- **Why:** The issue asks that nothing look like it is progressing when it is not. A ticket in `working` whose worker
  failed or cannot be reached is the common case where the ticket's own state would mislead.
- **Other options:** Grouping by state; showing failures only in the detail; translating the hub's English reasons.

## 2026-11-17 — The ticket's detail, its panel and its controls

- **Chosen:** The prototype's detail: a header (state, 工单 n, repository, kind, title), the timeline and the panel beside
  it, which on a phone comes first with its summary (state, what went wrong, where it runs, the pull request, the guided
  round when there is one, 改派 and 停止) and opens the rest on 详情: the issues in order by their Chinese titles linked to
  GitHub, repository, branch and pull request linked to GitHub, and machine, engine, model and effort, each with a person
  mark when the owner chose it, and 实际运行 with what the program reported. The timeline holds the filing with the
  summary, every move in Chinese with its reason, and one entry per attempt (engine, model, effort, machine, and 第 n 次
  after the first) whose log reuses 对话's parts: the worker's text as Markdown with the cursor while it streams, each
  command folded with its output, messages from the owner, the brain or the hub, and the ending (the pull request, the
  delivered text and files with the worker's note, the failure with its reason, or the stop). The verification rule is
  left out until #15 gives the ticket one. 停止 takes two presses like 确认: the first turns the buttons into a red 停止 on
  the left and 取消 where 停止 was, which takes the focus. 改派 opens the start card's three selects in the panel,
  starting from the ticket's current choice, limited to machines fitting its platform and, for code, without
  Antigravity; a changed engine sends no model, so the hub's table fills it. The reply box shows only while a reachable
  worker runs. The page opens a ticket at its top and follows new output only when the owner has scrolled to the bottom
  of a page longer than the screen; sending a message makes it follow.
- **Why:** The look is the prototype's; the roles it showed (reviewer, repairer, CI panel) are gone. Moving the
  confirming button is the guard already chosen for confirmation cards. Following only from the bottom keeps a long log
  readable while it grows.
- **Other options:** A dialog for 停止 or 改派 as in the prototype; a radio list of machine and engine; always following
  the newest output; a separate scrolling box for the log.

## 2026-11-17 — Scripted workers in the development harness

- **Chosen:** `tools/page-dev` attaches two scripted machines, `studio` (Windows) and `mini` (macOS), to the hub's real
  runner link in its own process, offering Codex, Claude Code, dsh and Antigravity with the design's models. A scripted
  worker streams text, runs pretend commands with output line by line, takes the owner's messages into its turn and
  answers them, stops when told, and ends as planned: endless work, a pull request, a failure (only on its first
  attempt, so 改派 can succeed) or a delivered text and file. `/__harness/scenario` opens and starts seven tickets
  through the hub's own services: a chain of three issues and a ticket waiting behind it in one repository, a failing
  and a finishing ticket in another, a ticket on `mini`, a writing ticket that delivers and a writing ticket without a
  task, whose begin fails. `/__harness/scripted?machine=&to=offline|online` cuts or restores a machine.
  `--credentials placeholder` gives the hub a placeholder GitHub token, which code tickets need before the hub sends
  them to a runner; nothing real accepts it.
- **Why:** The detail needs every state and a live stream to be checked by looking, without spending a subscription or
  filing anything on GitHub.
- **Other options:** A real worker on the sandbox repository; a fake runner process connecting over the network; writing
  events into the database directly.

## 2026-11-17 — A worker's commentary is Chinese

- **Chosen:** `WORKER.md` and `WRITER.md` tell the worker to write its running commentary, and anything else it says
  that is not a command, code, a commit, a pull request or an issue, in Simplified Chinese, since the owner reads it
  live in the ticket's timeline; what goes into the repository or to GitHub stays English, and a writing worker's
  result is in the language the task asks for. The harness's scripted workers speak Chinese.
- **Why:** The design shows the owner Chinese only, except raw material; commentary is prose written to be read.
- **Other options:** Translating the commentary in the hub; showing it in English as raw material.

## 2026-11-17 — PR in the catalog

- **Chosen:** `PR` is kept as it is in the interface's Chinese text, like GitHub and hub, and added to the terms the
  catalog's test accepts.
- **Why:** The prototype says PR, and it is the term the owner reads on GitHub.
- **Other options:** 拉取请求; 合并请求.

## 2026-11-17 — How the hub reaches Woodpecker

- **Chosen:** `deploy/compose.yaml` gives the hub the extra host entry `novanstorage.tail62dd17.ts.net:100.72.209.101`,
  and `WOODPECKER_SERVER` stays as it is. The name resolves to the NAS's Tailscale address only through Tailscale's
  resolver on the host; Docker's resolver answers the container with the name's public records, Tailscale's relay
  addresses, and a request there times out. A request from inside the running hub with curl's `--resolve` to that
  address answered `/version` and `/api/user`, which proved the remedy without changing the container.
- **Why:** The name is kept, so TLS still checks the server's certificate; nothing outside this project changes.
- **Other options:** Joining the Woodpecker server's Docker network and calling it over plain HTTP, which ties the hub
  to another project's network; host networking for the hub; changing `WOODPECKER_SERVER` to the bare address, which
  breaks TLS.

## 2026-11-17 — The Woodpecker workflows

- **Chosen:** `.woodpecker/check-macos.yaml` and `.woodpecker/check-windows.yaml`, selecting their agents by the label
  each agent requires, `target: macos` and `target: windows` (the agents declare `!target=macos` and `!target=windows`,
  so a workflow without the label is never taken). Both run on `pull_request`, on `push` to `main`, and on `manual`.
  Each downloads the Node version in a new `.node-version` (24.14.1, the Dockerfile's) from nodejs.org into the
  workflow's own folder beside the checkout, checks it against the release's `SHASUMS256.txt`, installs the pnpm of
  `packageManager` with that Node's npm into the same folder, then runs `pnpm install --frozen-lockfile` and
  `pnpm check`. The macOS step runs in `bash` (the local backend runs it with `-e`); the Windows step runs in Windows
  PowerShell, which stops on its own errors but not on a failing program, so every program call is followed by an exit
  on a non-zero `$LASTEXITCODE`. The clone step sets `lfs: false`, since the Mac mini's Git has no LFS. The pull request
  pipeline checks out the head commit itself, not a merge with `main`.
- **Why:** The agents are shared and must not change, and neither has a pinned Node and pnpm in its own path. The
  folder beside the checkout is removed with the workflow and is outside the files the zero-comment check reads. A push
  to `main` gives the merged commit its own result.
- **Other options:** Using the Node installed on each machine, which is not pinned; corepack, which needs its signing
  keys to know the pnpm release; one workflow with a matrix, which cannot choose a shell per platform; running only on
  pull requests.

## 2026-11-17 — The repository on the Woodpecker server

- **Chosen:** `novan-xu/super-agent2` was activated through the API with the owner's token from inside the hub
  (repository id 6), which made the GitHub webhook. Its settings were left at the server's defaults: pull requests
  allowed, approval for forks only, a 60-minute limit, and a running pipeline cancelled by a newer `push` or
  `pull_request` pipeline. Nothing else on the server was changed.
- **Why:** The defaults are what the checks need; a commit superseded on the same pull request need not finish.
- **Other options:** Keeping superseded pipelines running.

## 2026-11-17 — What the hub will read from Woodpecker

- **Chosen:** Recorded for #15, from the server as it answers today.
  - GitHub shows one commit status per workflow, with the contexts `ci/woodpecker/pr/check-macos` and
    `ci/woodpecker/pr/check-windows` on a pull request's commit, and `ci/woodpecker/push/check-macos` and
    `ci/woodpecker/push/check-windows` on a push. Each status's `target_url` is
    `<server>/repos/<repo id>/pipeline/<number>/<workflow pid>`, so the pipeline is named by the status itself.
  - The repository's id comes from `GET /api/repos/lookup/novan-xu/super-agent2`. A pipeline is found from a commit by
    listing `GET /api/repos/<id>/pipelines?event=pull_request&ref=refs/pull/<n>/` (the list has no commit filter; a
    pull request's pipelines carry the ref `refs/pull/<n>/merge` but run the head commit) and taking the newest whose
    `commit` is the head's SHA, or by the number in the status's `target_url`.
  - `GET /api/repos/<id>/pipelines/<number>` returns `status` and `workflows`, each with `name`, `state` and
    `children`, the steps, each with `id`, `name`, `state` and `exit_code`. A failing step is a child whose `state` is
    `failure`.
  - `GET /api/repos/<id>/logs/<number>/<step id>` returns the step's log as an array of lines whose `data` is the
    line's bytes in base64.
  - Every request carries `Authorization: Bearer $WOODPECKER_TOKEN`; the token is the owner's, with administrator rights.
- **Why:** #15 waits for these pipelines and hands a failing step's log to the brain.
- **Other options:** Reading only GitHub's statuses, which carry no logs.

## 2026-11-17 — What the first runs on macOS and on the Windows agent found

- **Chosen:** Two fixes. On macOS the temporary folder is reached through `/var`, a link to `/private/var`, so a command's
  working folder printed by the command differs from the one asked for; the hub's test now compares the real paths of
  both. On the Windows agent the temporary folder is the short name `C:\Users\WOODPE~1\...`, whose `~` the hub's issue
  filing refused as a character a shell would read; the filer now names its scratch file by the folder's real path,
  which has no short names and no links, and a test reaches the scratch folder through a link named `SCRATC~1`.
- **Why:** Both were assumptions of the one machine the code had run on. The second would also stop a hub run on any
  Windows machine whose temporary folder has a short name.
- **Other options:** Loosening the filer's check to accept `~`; setting `TMP` and `TEMP` in the workflow, which would
  hide the fault instead of fixing it.

## 2026-11-17 — Pull requests wait for Woodpecker from here on

- **Chosen:** From #15 on, a pull request for this repository is merged only when both Woodpecker workflows on its head
  commit are green, in addition to the review by the orchestrating session.
- **Why:** #14 put the repository under CI on macOS and Windows, and its first run found three faults that the check on
  this PC alone had never shown. The earlier entry "How the issues are built" said the local check was the only one
  until then.
- **Other options:** Keep merging on the local check alone.

## 2026-11-17 — How the hub reads GitHub and Woodpecker to verify and merge

- **Chosen:** The verification service (`packages/hub/src/verification.ts`) calls GitHub's REST API and Woodpecker's API
  itself with `fetch` (`github-api.ts`, `woodpecker.ts`), not through the command channel. GitHub is called with the
  token of the account that owns the repository (`accountFor`, as for filing and workers), Woodpecker with
  `WOODPECKER_SERVER` and `WOODPECKER_TOKEN` from the same credential source. Each request has a 60-second limit of its
  own; a request that fails or times out is recorded on the ticket as what it waits for and is tried again at the next
  check, and never fails the ticket.
- **Why:** The hub checks every ticket in verifying every 30 seconds; through the command channel each check would be
  several stored commands in the owner's command list, and its answers would have to be parsed back out of output. The
  merge itself is the owner's token doing what the design says it may (no GitHub rule it cannot bypass), and it is
  recorded on the ticket, which is where the owner looks. A request without a limit could hang one ticket's checks for
  ever; its limit is network hygiene, not a deadline for the pipeline.
- **Other options:** `gh api` on the `hub` target through the command service, as `file_issue` does; reading only
  GitHub's commit statuses, which carry no logs and do not say which workflows to expect.

## 2026-11-17 — Which files are text and documentation

- **Chosen:** Data in `packages/protocol/src/verification.ts`: the extensions `.md .markdown .mdown .rst .adoc .asciidoc
  .txt .text`, and the names `README`, `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `AUTHORS`, `CONTRIBUTORS`,
  `CHANGELOG`, `CHANGES` and `HISTORY` without an extension, in any case; except `requirements*.txt`,
  `constraints*.txt` and `CMakeLists.txt`, which are build inputs. A pull request is documentation only when every
  file it changes, and the old name of every file it renames, is one of these; a pull request with no files is code.
  The files are GitHub's list for the pull request (up to 3000, paged).
- **Why:** These are the formats people write prose in. `.mdx` is JSX and `.svg` is markup a build can use, so both are
  code. A rename from `app.ts` to `app.md` removes code. In this repository a Markdown file can still fail `pnpm check`
  (a comment in it), and the design accepts that a documentation-only change merges without CI.
- **Other options:** Treating `docs/` folders as documentation whatever the type; including images and `.mdx`; leaving
  `.txt` out entirely.

## 2026-11-17 — Which workflows the hub expects, and "not reported yet" against "none"

- **Chosen:** For a code pull request the hub first asks Woodpecker for the repository (`/api/repos/lookup/<owner>/<name>`).
  Unknown (404) or not active: the repository has no Woodpecker workflow, and it merges by the rule `none`. Active: the
  hub reads the configuration at the pull request's head commit from GitHub, at the repository's `config_file` when it
  is set and otherwise at `.woodpecker/` (its `.yml` and `.yaml` files), `.woodpecker.yaml`, then `.woodpecker.yml`, the
  order Woodpecker uses. No configuration at the head: rule `none`, merge. Otherwise each file is an expected workflow,
  named as Woodpecker names it (the file name without its extension and leading dot). When the hub has no
  `WOODPECKER_SERVER` and `WOODPECKER_TOKEN` (the development harness on this PC), it reads the same default paths from
  GitHub: none means `none`; some means the ticket waits, saying the hub cannot read their results.
- **Why:** "Not reported yet" and "this repository has none" look the same from Woodpecker's pipeline list alone; the
  configuration at the head is what says whether a pipeline is coming. Reading it at the head, not the default branch,
  makes a pull request that adds or removes a workflow judged by what it will run.
- **Other options:** Expecting the contexts GitHub showed on earlier commits; a list of expected workflows per
  repository kept in the hub; treating a repository unknown to Woodpecker as waiting.

## 2026-11-17 — What counts as green, and what never does

- **Chosen:** The pipeline is the newest one Woodpecker lists for the pull request (`event=pull_request`,
  `ref=refs/pull/<n>/`, filtered again in the hub) whose `commit` is the head's SHA; it is read in full, with its
  configuration (`/pipelines/<n>/config`). Green is: the pipeline's own commit is the head; every configuration file
  the head defines is in the pipeline's configuration; the pipeline has at least one workflow; every workflow's state
  is `success`; and the pipeline's status is `success`. A configuration whose workflow is absent from the pipeline is
  one Woodpecker filtered out by its own `when` (seen on the server: `super-agent`'s path-filtered workflows), and does
  not apply. Not green, and the ticket waits, saying why: no pipeline for the head yet (a pipeline for an older commit,
  another pull request or a push does not count); `pending`, `running` or `created`; `killed`, `skipped`, `declined`,
  `blocked` or anything else not `success`; a configuration the head defines that the pipeline was not built from. A
  new head starts the wait again, and a restarted pipeline (a higher number for the same commit) replaces the old one.
  Red is a workflow in `failure` or `error`, or a pipeline in either state.
- **Why:** The issue asks never to merge on the wrong evidence. Woodpecker evaluates `when` itself; the hub does not
  re-implement it, but it does check that the pipeline came from the head's own configuration.
- **Other options:** GitHub commit statuses; accepting a green push pipeline of the same commit; counting a cancelled
  pipeline as red.

## 2026-11-17 — When the hub checks, and what it never does

- **Chosen:** A ticket is checked when it moves into verifying, at the hub's start (every ticket in verifying, and every
  merged ticket whose report was not told), and every 30 seconds while it is in verifying (10 in the development
  harness). A check reads the pull request first; a ticket whose verification failed or whose conflict was not
  resolved costs that one request until its head changes. Checks of one ticket run one at a time, and at most one more
  waits behind a running one. Nothing is decided from time: a pipeline that never reports leaves the ticket in
  verifying, waiting, with what it waits for on the page; no check fails a ticket.
- **Why:** The hub is behind Cloudflare Access, so neither GitHub nor Woodpecker can call it. Thirty seconds keeps a
  ticket's cost near 2 requests a minute while it waits, well inside GitHub's 5000 an hour.
- **Other options:** Webhooks through a public endpoint; backing off the interval over time; a time limit after which
  the brain is told.

## 2026-11-17 — How the merge is done, exactly once

- **Chosen:** The pull request is re-read immediately before merging; it merges only when it is still open, its head is
  the commit that was judged, and GitHub says it merges cleanly (`mergeable` true; while GitHub has not worked it out
  the ticket waits for the next check). The merge is `PUT /pulls/<n>/merge` with `sha` set to that head, so a push in
  between is refused by GitHub (409) and the rules apply again to the new head. The method is squash when the
  repository allows it, otherwise a merge commit, otherwise rebase. Before calling it the hub records the head and the
  rule it is merging with; after it, it records the merge commit, closes each issue of the chain that is still open
  (recording each), deletes the ticket's branch on GitHub when the pull request came from it, reads whether the
  deployment file exists at the merge commit, and only then moves the ticket to merged and tells the brain, recording
  that it told. A pull request found merged at a check (the answer to the merge was lost, the hub restarted, or the
  owner merged it on GitHub, which is recorded as the rule `outside`) is finished the same way, and nothing merges
  twice: every step is recorded and skipped once done, the move to merged is allowed once, and the chain service
  begins a waiting ticket only in the transaction that moves it from waiting. A step that fails leaves the ticket in
  verifying as "merged on GitHub, finishing", tried again at the next check.
- **Why:** The issue asks that a repeated event, a restart or two triggers at once never merge, close or begin twice.
  Squash keeps one commit per ticket on the default branch, as this repository's own pull requests are merged. The
  branch is the hub's own `sa2/ticket-…` branch and is restorable from the pull request page; keeping it would leave
  one stale branch per ticket.
- **Other options:** A merge commit always; leaving the branch, or relying on the repository's "delete branch on merge"
  setting; closing issues through `Closes #n` in the merge message alone, which GitHub does not do for every merge.

## 2026-11-17 — A red workflow, and the place left for the failure loop

- **Chosen:** A red pipeline is recorded on the ticket's verification as `failed`, with the pipeline, the state of each
  workflow, every failing step (workflow, step, exit code) and each failing step's log from Woodpecker (the lines
  decoded, at most 20000 characters, kept in `ticket_verifications.logs`). The ticket stays in verifying, the brain is
  told once per head and pipeline with the reason and the end of each log, and `read_ticket` shows the logs. Nothing is
  retried, no pipeline is run again, and the ticket is not sent back to its worker. A new head (a push to the branch, or
  #16's guided round through `WorkService.again`, which moves it to working and back) starts the rules again.
- **Why:** #16 owns the loop. Verifying with a recorded failure is where #16 will pick it up: `again` already moves a
  verifying ticket back to working.
- **Other options:** Moving the ticket to working with the failure, as a failed worker is; stopping it.

## 2026-11-17 — A conflict at merge time

- **Chosen:** When GitHub says the pull request does not merge cleanly (`mergeable` false, or 405 on the merge with
  `mergeable` false), the hub calls `WorkService.again` with a note telling the worker to merge the latest base branch,
  resolve, test, push and hand back the same pull request; the ticket moves to working with the reason "和 main
  有冲突，交回工作者解决". When it hands back, the rules apply to the new head. The same conflict on the same head is sent
  back only once: if the worker hands back without a new commit and it still conflicts, the verification is recorded as
  `conflict` and the brain is told, which is #16's "a conflict the worker did not resolve". A skip in force is dropped
  when the ticket goes back, so the rules apply again after the fix.
- **Why:** The issue gives the conflict to the worker. Sending the same head back again would loop without a cap.
- **Other options:** Telling the brain first; resolving conflicts in the hub.

## 2026-11-17 — The brain's skip shortcut

- **Chosen:** A tool, `merge_ticket`, with the ticket and a `reason` in English. It is refused unless the ticket is in
  verifying. It records the skip on the ticket and runs a check at once that skips the rules: the head is re-read and
  merged with its SHA, and everything a merge does follows, with the rule `skipped` and the reason in the brain's report.
  The skip stays recorded until the merge or until the ticket goes back to its worker, so a check that cannot merge yet
  (GitHub still working out whether it merges) merges at the next check. The tool answers with the outcome. The
  brain's guidance says to use it only when the owner asks.
- **Why:** The design gives skipping to the brain and does not list merging as irreversible.
- **Other options:** A skip flag on a general merge tool; asking the owner on the page.

## 2026-11-17 — Where a repository declares its deployment

- **Chosen:** `.superagent2/deployment.json` at the root of the repository (`deploymentFile` in the protocol). This issue
  only checks that it exists at the merge commit; the brain's report says the repository has a deployment and so the
  change needs deploying, or that it has none and nothing needs deploying, and names the tickets that wait for that
  deployment. #17 defines its contents (target, deploy command, health check, rollback command).
- **Why:** JSON is read with zod and no new dependency, and it cannot carry comments, which the repository rule forbids
  anyway. A folder named after the system keeps it apart from the repository's own files.
- **Other options:** YAML; a root file such as `deploy.json`; a setting kept in the hub per repository.

## 2026-11-17 — What the page shows of verification

- **Chosen:** A ticket carries `verification` (head, level, rule, state, what it waits for, the reason as recorded, the
  pipeline, the workflows, the failing steps, the merge commit, the deployment flag). The detail's panel shows 验证 with
  the rule and 流水线 with a link to the pipeline. The ticket's state reads 验证中 while it is checked or waits, with
  what it waits for under it (for example 等 Woodpecker 为 abc1234 建流水线, and the hub's English reason as raw text);
  验证没通过, with the failing workflow and step, when it is red; 有冲突 when a conflict was not resolved. The move to
  merged carries the rule in Chinese, which the timeline shows. `Woodpecker` is kept as it is in the catalog, like
  GitHub.
- **Why:** The design says a ticket shows which verification rule applied; what it waits for is what the owner needs
  to see that nothing is stuck by mistake.
- **Other options:** A separate verification section in the timeline; translating the hub's reasons.

## 2026-11-17 — Verification in the development harness, and what was verified live

- **Chosen:** `tools/page-dev` checks verifying tickets every ten seconds, reaches GitHub only with `--credentials
  environment` (otherwise its forge refuses every request, so scripted tickets with placeholder tokens call nobody),
  takes `after=<ticket>` on `/__harness/work` to start a chain behind a started ticket, and calls any brain tool with
  `/__harness/tool?name=&args=`. Verified on this PC with the harness and one local runner (Claude Code,
  `claude-haiku-5-5`, medium) against `novan-xu/super-agent-sandbox`, which has no Woodpecker workflow and is not on the
  Woodpecker server: a documentation-only ticket merged by the rule `documentation` six seconds after it reached
  verifying; a code ticket merged by the rule `none`; the ticket arranged after it began when it merged and merged in
  turn; each merge closed its issue, deleted its branch, removed the worktree and told the brain with the deployment
  flag (false). With a `.woodpecker/` file put on the sandbox's `main`, a code ticket waited honestly ("the hub has no
  WOODPECKER_SERVER and WOODPECKER_TOKEN"); a conflicting commit was then pushed to `main`, and `merge_ticket` found the
  conflict and sent it back to the worker, which merged `main`, resolved it and handed back a new head; the ticket
  waited again, and `merge_ticket` merged it at once. The hub was restarted between the third and the fourth ticket and
  kept its state, and the runner reconnected by itself. Found
  live and fixed: GitHub refused to close an issue (422) that its own `Closes #n` handling was closing at the same
  moment; a failed close is now taken as done when the issue reads closed. Not verified live: the `workflows` rule
  against the real Woodpecker (this PC has no Woodpecker token), a red pipeline, and a repository with a deployment
  file; the tests cover them with a fake Woodpecker.
- **Why:** The harness exercises the real front door, start, runner link and GitHub; only Woodpecker is out of reach here.
- **Other options:** A local fake Woodpecker in the harness, which would have been a second fake rather than the server.

## 2026-11-17 — What a failure is, and what counts as a guided round

- **Chosen:** A failure is what the hub already records: a red workflow (verification `failed`), a conflict the worker
  did not resolve (verification `conflict`), and a failed attempt (`no-pull-request`, `program`, `lost`, `prepare`). A
  guided round is one call of `guide_ticket` after such a failure: the brain's guidance goes to the worker, which starts
  again on the same branch, resuming its session where the machine and engine are the same. It is counted when it
  starts, in the same transaction that inserts the attempt. Not failures, so never told as one and never counted: a
  dropped link to a runner that comes back with its worker still running, a machine that is offline (the attempt
  waits, queued or unreachable), and a pipeline that never reports (the ticket waits in verifying). A failure of the
  machine (`lost`, `prepare`) gets one retry that is not counted; a second failure of the machine in a row is counted,
  as is any failure of the work after it. The hub's own conflict send-back (the first time a head conflicts) is the
  design's merge step, not a failure, and is not a round; the owner's 改派 is the owner's action, not a round, and does
  not reset the count. The rules are plain functions in `packages/protocol/src/rounds.ts`: `countsAsRound`,
  `capReached`, `loopFailureOf`, `guidanceRefusal`, `nextRound`, `stuckOffers`.
- **Why:** The owner should be called for work that keeps failing, not for a machine restart or a slow pipeline; one
  free retry, and only one in a row, keeps a real failure from being hidden behind a machine that fails each time.
  Counting at the start of the round, in the hub, means a round the brain never started cannot be counted and one it
  started cannot be uncounted.
- **Other options:** Counting every attempt, which would call the owner for infrastructure; never counting machine
  failures, which lets a broken machine loop for ever; counting at the end of a round.

## 2026-11-17 — Where the count lives, and why nothing the brain calls can start a fourth round

- **Chosen:** The count is `tickets.round`, with `tickets.free_retry`, and `ticket_rounds` keeps each round (its number,
  or none for an uncounted retry, the attempt it started, the failure it answered, and the guidance in English and
  Chinese). The only writer that raises it is `TicketWrites.startRound`, which throws when a counted round would go past
  three; the only writer that lowers it is `TicketWrites.resume`, called only from the owner's answer. At the third
  failure after three rounds the hub moves the ticket to `stuck` itself. Every path to another attempt was checked:
  `guide_ticket` refuses past the cap and on a stuck ticket; `WorkService.again` with a round re-checks the rules and the
  write refuses; `again` without a round (the conflict send-back) and the owner's 改派 need the ticket in working or
  verifying, which a stuck ticket is not; `merge_ticket` needs verifying; `message_worker` needs a running worker;
  `stop_ticket` is refused on a stuck ticket (the decision is the owner's), and a stopped ticket has no moves, so it
  cannot be reopened; a new ticket for the same issue starts only with the owner's 开始; verification checks and the
  runner's reconnection never make a new attempt. The owner's answer is the page's own request with the owner's signed
  assertion, a same-origin `Origin` and a JSON body, which the brain cannot make.
- **Why:** The cap is one of the five constraints in code. Putting the throw in the write that inserts the round, not
  only in the tool, holds it for any caller.
- **Other options:** A check in the tool alone; a separate table of caps per ticket; letting the brain stop a stuck
  ticket.

## 2026-11-17 — The stop at the cap is a state of its own

- **Chosen:** A new ticket state `stuck` (等你决定). Working and verifying move to it, and it moves back to the state it
  came from (`stuck_from`), or to stopped. It is open, not finished, so nothing removes the worktree: the branch, the
  pull request and the worker's output stay, and a runner that reconnects keeps the folder. While it is stuck no
  worker is dispatched, verification does not check it, and it is not reassignable. The ticket records when it
  stopped, at which round, the failure, and where it is stuck in the brain's words. A move from stuck back to verifying
  does not count as a new hand-back, so the rules are not run again and the failure is not told twice.
- **Why:** `stopped` is final and removes the worktree; the owner must be able to resume the same ticket.
- **Other options:** Using `stopped` and opening a new ticket on resume; a flag on a working ticket, which every path
  would have to remember to check.

## 2026-11-17 — The owner's answer, and the card in 等你

- **Chosen:** A stuck ticket is a card in 等你 (`StuckCard`, key `stuck:<ticket>-<time it stopped>`) with the ticket's
  title linked to it, the failure, 第 n 轮, the repository, and where it is stuck: the brain's `describe_stuck` text, or,
  until the brain has written it or if it cannot, the last guidance and the hub's failure as recorded. It has a box for
  words to the brain, 继续, and 放弃, which takes a second press. `POST /api/tickets/<n>/answer` with
  `{"at", "answer": "resume" | "give-up", "words"?}` answers it; a stale `at` is refused. Resume moves it back with the
  count at zero, starts nothing, and tells the brain with the owner's words and the failure, so the brain's next guidance
  is round 1 of the new count. Give up stops the ticket ("引导到上限后，你放弃了它"), which removes the worktree. The card
  appearing sends one push notification, 工单 n 引导 3 轮还没通过，等你决定, to the card's address.
- **Why:** The design says the owner is involved after three rounds, and the card is the one place the count can be
  reset. The worker hears only from the brain, in English, so the owner's Chinese words go to the brain.
- **Other options:** Resuming with the owner's words sent straight to the worker; a resume that starts a round at once;
  the stuck ticket's panel as the place to answer.

## 2026-11-17 — What the brain is handed, and in which conversation

- **Chosen:** For a red workflow, the end of each failing step's log from Woodpecker (kept as its last 20000 characters,
  handed as its last 8000); for a failed worker, the end of its output (8000 characters), which now includes a command's
  streamed output when the program sends no final output; for an unresolved conflict, the files changed both by the pull
  request and on the base branch since it branched, from GitHub's compare. A text cut to its end says so: "[the first n of
  m characters are cut; this is the end, where the failure is]". The message says which round the guidance would start,
  or that the cap was reached. These are notices with a prompt in the ticket's own conversation (where it was filed),
  or, for a ticket with none, the most recent conversation, as every other notice of the hub; the brain takes each as a
  turn without the owner sending anything, and the owner sees the notice, the brain's tool calls and its answer in
  对话.
- **Why:** The failing line is at the end of a log; the beginning of a 20000-character log is setup noise. A conversation
  of its own per ticket would hide the loop from where the owner talks to the brain.
- **Other options:** Head and tail, as `clip` does; a conversation per ticket; asking the brain to read the logs itself.

## 2026-11-17 — The failure loop in the development harness

- **Chosen:** `tools/page-dev --forge fake` serves GitHub and Woodpecker from the hub's fake forge (moved from
  `src/testing` to `src/fake-forge.ts` and exported, as the push test device already is), with placeholder tokens, and
  checks verifying tickets every two seconds. A scripted worker that hands back registers its pull request there with a
  new head and a pipeline. `/__harness/loop?case=` starts a scripted ticket on `studio`: `fixed` (red once, then
  green), `red` (red every round), `stuck` (the worker fails every round), `worker` (the worker fails once). The demo
  brain answers a hub failure with `guide_ticket`, quoting the failing line, and the cap with `describe_stuck`.
- **Why:** The loop has to run with nobody at a computer, and a red pipeline on demand needs a Woodpecker the harness
  controls; the real server is out of reach from this PC.
- **Other options:** A second fake inside page-dev; driving the tools by hand.

## 2026-11-17 — What was verified of the failure loop

- **Chosen:** Recorded as verified on this PC. With `--forge fake`, scripted runners and the demo brain, unattended: a
  ticket whose first pipeline was red was guided once and merged (round 1); a ticket whose worker failed every time went
  through three guided rounds, stopped as `stuck` with its branch and output kept, appeared as a card in 等你, and a
  pretend device received the push 工单 2 引导 3 轮还没通过，等你决定; through the brain's tools endpoint `guide_ticket`,
  `merge_ticket`, `stop_ticket` and `message_worker` were refused and the owner's 改派 answered 409, with no fifth
  attempt; the owner's answer from another origin (403), not as JSON (415) and with a stale card (409) was refused, and
  the owner's answer with words resumed it with the count at zero, after which the demo brain's guidance was round 1
  again; the ticket's timeline showed each round with the guidance in Chinese. With the real `claude` brain, a local
  runner (Claude Code, `claude-haiku-5-5`) and `novan-xu/super-agent-sandbox` issue #91, made to fail once: the worker
  stopped without a pull request as the issue said, the hub told the brain, and the brain's guidance (round 1) quoted
  the issue's rule, said the first session was over, and told the worker to add `loop-check/product.txt` with 391, open
  the pull request closing #91 and check it with `git show`, `cat` and `gh pr view` before handing back. The worker did,
  and pull request #92 merged by the documentation rule, closing #91. Not verified live: a red pipeline on the real
  Woodpecker server and an unresolved conflict against GitHub; the tests cover both with the fake forge.
- **Why:** The issue's "Done when" list, on this PC.
- **Other options:** None.

## 2026-11-17 — The Unicode characters each shell reads as ordinary ones

- **Chosen:** The sets below are kept as data in `packages/hub/src/unicode.ts` and were found on this PC by experiment,
  never by running a destructive command. PowerShell 5.1 (5.1.26100): every character from U+0001 to U+FFFF, surrogates
  excepted, was given to `[System.Management.Automation.Language.Parser]::ParseInput` as `a<c>b`, `a <c>b`,
  `1 <c>eq 1`, `a <c>x y<c>` and as the closing character of `'x` and `"x`, and the tokens were read. White space:
  U+0009, U+000B, U+000C, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F and
  U+3000; only U+000A and U+000D end a line. Dashes that start a parameter or an operator: U+002D and U+2013 to U+2015;
  U+2010 to U+2012, U+2212 and the full-width hyphen are ordinary characters. Single quotes: U+0027 and U+2018 to
  U+201B; double quotes: U+0022 and U+201C to U+201E. Any quote of a kind closes a string opened by any quote of the
  same kind, two in a row stand for one, and the curly ones also open and close here-strings (`@‘`, `’@`). A dash
  counts only at the start of a word (`a–b` is one word); `–Recurse` binds as `-Recurse` for a cmdlet, while a native
  program is handed the en dash itself; `––` is the end-of-parameters token, and `–-%` is not the stop-parsing token.
  `powershell.exe` accepts `–NoProfile –Command` on its own command line. No look-alike separator (full-width `；`,
  `｜`, `＆`) splits a statement, and U+200B and U+180E do not split a word. PowerShell 7 is not installed on this PC,
  so it was not checked; the sets above are the ones the PowerShell reading uses for both. cmd (Windows 11, run through
  `cmd /d /c` with `echo<c>zz` and `dir /b<c>C:\Windows\win.ini` for 150 candidate characters): it ends the command
  name and splits arguments at the same white space as PowerShell plus U+180E, and not at U+200B; curly quotes are not
  quotes, en and em dashes do not start a switch, and full-width separators do not separate. The PowerShell reading now
  treats PowerShell's white space, dashes and quotes as PowerShell does; the text given to `cmd /c` has cmd's white
  space read as spaces before it is read; the POSIX reading is unchanged, since a POSIX shell splits only on space, tab
  and newline and has only ASCII quotes.
- **Why:** A command written with these characters runs as the listed form in PowerShell or cmd, and the lock must
  read it the way the shell that runs it will. Probing the tokenizer itself, character by character, gives the exact
  sets rather than a remembered approximation.
- **Other options:** Treating every Unicode space and dash as ASCII in every reading, which would make the POSIX reading
  split where bash does not; reading `cmd /c` text with a reader of its own.

## 2026-11-17 — Invisible and look-alike characters in a command

- **Chosen:** Besides the two readings, the lock reads every script (the command and every script inside it) a second
  time with invisible and look-alike characters folded, and holds the command if that reading matches a listed form.
  Folding, kept as data in `packages/hub/src/unicode.ts`: invisible characters are removed (soft hyphen, combining
  grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent vowels, Mongolian variation selectors, U+200B to
  U+200F, the bidirectional embeddings, overrides and isolates U+202A to U+202E and U+2066 to U+2069, U+2060 to U+2064,
  U+206A to U+206F, variation selectors, U+FEFF, the interlinear annotation characters, the shorthand format controls,
  the musical format controls and the tag characters); look-alike spaces (cmd's white space beyond ASCII) become a
  space; look-alike dashes (U+02D7, U+2010 to U+2015, U+2043, U+2212, U+FE58, U+FE63, U+FF0D) become `-`; look-alike
  slashes (U+2044, U+2215, U+29F8) become `/`; Cyrillic, Greek, Armenian and Latin small-capital letters that look
  like ASCII letters become them; any other character whose NFKC compatibility form is made only of ASCII letters,
  digits, space and `.,:;|&=+~@%!_*/-` becomes that form (full-width letters, digits and separators, mathematical
  letters, ligatures). Look-alike quotes are removed, except the curly quotes the PowerShell reading already reads as
  quotes. Quotes, `$`, backticks, backslashes, brackets, `<`, `>` and `#` are never produced by folding, so folding
  never opens or closes a quoted string or a substitution; the quoting of the folded text is the shell's own. ASCII
  text is never folded, so ordinary commands are read exactly as before. In effect a command is held when an invisible
  or look-alike character sits in the program name, a subcommand, a flag or a target of a listed form, or joins such a
  word to the rest of the command (a zero-width word between `repo` and `delete`, a full-width `；` before `gh`), and
  folding it away makes the form appear. Chinese, Japanese, emoji, accented letters and full-width punctuation inside
  a commit message, an issue title, a file name or an echoed string stay one word under folding, so they never make a
  form appear and run as before.
- **Why:** The reader cannot be sure what such a command does: a bidirectional override can show `delete` while the
  shell sees something else, and a look-alike letter makes a listed command look like another. In a POSIX shell the
  command usually fails rather than doing harm, but a needless hold here costs one click on a command no one writes by
  accident, while a miss cannot be undone. Folding the text and reading it again keeps one definition of the forms,
  instead of a second list of suspicious spellings.
- **Other options:** Holding every command with any invisible or non-ASCII character, which would hold every Chinese
  commit message; folding inside words only, which misses a look-alike separator joining a form; holding only when
  the folded word equals a listed word, which would need every form restated; the full Unicode confusables table,
  which maps CJK and other everyday characters and would be larger than the reader.

## 2026-11-17 — What the deployment file holds

- **Chosen:** `.superagent2/deployment.json`, read with zod as `DeploymentFile` in `packages/protocol/src/deployments.ts`,
  strict (an unknown key is refused, so a typo or a credential written into it is caught): `target` (a target name:
  `hub`, `nas` or a runner), `folder` (optional working folder on the target), `deploy` (a command), `health`
  (`command`, `everySeconds` default 5, `withinSeconds` default 120), and `rollback` (a command). The health check is a
  command on the target that exits with 0 when the service answers; there is no address for the hub to fetch.
- **Why:** A command on the target reaches whatever the service listens on there (a port on the NAS, a runner's
  localhost), which the hub's own container often cannot; `curl` covers an address. One kind keeps the file small.
- **Other options:** An address fetched by the hub, or both; YAML; a per-repository setting kept in the hub.

## 2026-11-17 — What the commands of a deployment receive

- **Chosen:** A command can now carry environment variables (`environment` in `CommandRequest`, stored with the command,
  so a held command keeps them across a restart). A deployment's commands get `SUPERAGENT2_REPOSITORY`,
  `SUPERAGENT2_COMMIT` (the commit being deployed), `SUPERAGENT2_PREVIOUS_COMMIT` (the commit of the repository's last
  successful deployment through the hub; unset when there is none) and `SUPERAGENT2_DEPLOYMENT` (its number), besides
  the owner's credentials as every command has. A credential always wins over a variable of the same name. They run as
  the account that owns the repository.
- **Why:** Variables reach every target the same way (the hub's shell, the NAS through `bash -s`, a runner on Windows or
  macOS), where text put in front of the command would need each shell's syntax, and they leave the command the lock
  reads unchanged.
- **Other options:** Prefixing the command with assignments; placeholders substituted into the command text.

## 2026-11-17 — The previous version, and a first deployment

- **Chosen:** "The previous version" is the commit of the repository's last deployment through the hub that succeeded,
  taken from the hub's own record when the deployment starts. The rollback command receives it in
  `SUPERAGENT2_PREVIOUS_COMMIT` and is expected to deploy it. A deployment with no such record (a first deployment) is
  not rolled back when it fails: it ends `failed`, saying there was nothing to roll back to. The brain can name the
  commit running now with `previous` on `deploy_repository`; it is used only while the hub has no successful deployment
  on record.
- **Why:** Only the hub's record is known to be true; a rollback to a guessed commit could be worse than the failure.
  Super-agent2 itself (#18) was deployed by hand first, which `previous` covers.
- **Other options:** Running the rollback with an empty previous commit; reading the running version from the target.

## 2026-11-17 — How a deployment runs, and what ends it

- **Chosen:** `packages/hub/src/deployments.ts`. The brain's `deploy_repository` resolves the commit (a SHA or a branch)
  through GitHub, reads the file at that commit through GitHub, and refuses with the reason, running nothing, when there
  is no such commit, no file, a file that does not parse, a target the hub does not know, or another deployment of the
  same repository still running (the answer names it). Otherwise it records the deployment, starts the deploy command
  through the command service and returns. Every command (deploy, each health check, rollback) goes through the same
  service and the same lock as any other; a held one is waited for, as long as the owner takes. After the deploy command
  exits with 0 the health check runs every `everySeconds` until it passes or `withinSeconds` have passed (the check that
  runs at the end of the period counts, and a check still running then is stopped); time comes from the hub's clock and
  an injected sleep, which the tests control. Results: `succeeded`; `rolled-back` (the deploy command failed or the
  service never passed, the rollback command exited with 0, and the health check then passed again within a new
  period); `unrecovered` (the rollback failed, did not run, or the service still did not pass); `failed` (no previous
  version, nothing rolled back); `not-run` (the deploy command never started: refused by the owner, no such target, a
  machine offline); `interrupted` (a command was cut off while it ran; its outcome is not known). A deploy command that
  ran and failed is rolled back like an unhealthy service. Deployments and their steps (each command's id, so its
  output and times) are kept in `deployments` and `deployment_steps`.
- **Why:** The brain asks for minutes of work with one call and is told the outcome without the owner sending anything.
  Rolling back after a failed deploy command restores a known state when the command left a half-done one.
- **Other options:** A tool that waits for the end; leaving a failed deploy command without rollback.

## 2026-11-17 — A restart of the hub during a deployment

- **Chosen:** At start the hub takes up every deployment that has not ended. A deploy or rollback command still held is
  waited for (held commands survive a restart). One that the restart cut off while it ran ends the deployment as
  `interrupted`: the record says the command was interrupted and whether it finished is not known; nothing is run again
  and nothing is rolled back. One that had not started yet ends it as `not-run`. A deployment that was in its health
  check starts the check again with a full period and a note saying so, since checks change nothing and the deploy
  command is known to have finished. A result recorded but not yet told to the brain is told once.
- **Why:** The issue asks for a truthful record and forbids running the deploy command twice or rolling back blindly.
  #18, where the deploy command restarts the hub itself, runs its own health check and rollback outside the hub and
  can build on the health check being taken up again.
- **Other options:** Running the health check after an interrupted deploy command and judging from it; rolling back
  every interrupted deployment.

## 2026-11-17 — What a successful deployment marks deployed

- **Chosen:** On success the hub marks deployed every merged ticket of the repository, not yet marked, whose merge commit
  is the deployed commit or one of its ancestors (GitHub's compare of the two answers `ahead` or `identical`), through
  the same path as `report_deployment`, so tickets waiting for that deployment begin. A comparison that cannot be read
  leaves the ticket unmarked with a note. `report_deployment` stays for work deployed by other means. The brain's merge
  report now names `deploy_repository` and the merge commit.
- **Why:** Deploying the default branch's head deploys every merge before it.
- **Other options:** Only the ticket whose merge commit is the deployed commit; every merged ticket of the repository.

## 2026-11-17 — Where the owner sees deployments

- **Chosen:** In 对话, where the brain was asked: its `deploy_repository` call as a tool entry, then one notice when the
  deployment ends, in Chinese from the catalog (for example "novan-xu/app 已部署到 abc1234，健康检查通过", or "… 没有成功，
  已回滚到 …，旧版本恢复正常"), which is the turn the brain answers. A held deploy or rollback command appears in
  工作台's 等你 like any held command. No deployment view and no new page code; the brain's `read_deployment` shows the
  steps and their output.
- **Why:** The owner asked the brain from 对话 and reads the answer there; the conversation is the smallest honest place.
- **Other options:** A section in 工作台; deployments in a ticket's detail; a notice when a deployment starts.

## 2026-11-17 — Deployments in the development harness, and what was verified

- **Chosen:** With `--forge fake`, a deployment file POSTed to `/__harness/deployment?repository=` is put into every
  later scripted pull request of that repository, so its merge needs deploying; `/__harness/loop?case=green&repository=`
  starts a ticket that merges green; the demo brain answers a merge that needs deploying with `deploy_repository` at the
  merge commit, and a deployment's result with a line in Chinese. Verified on this PC with a toy service in a scratch
  folder (a Node server on 127.0.0.1:5291 started detached by `node deploy.mjs <good|broken>` on the `hub` target, a
  health check `node check.mjs` that fetches it, and `node rollback.mjs`, which starts the release recorded for
  `SUPERAGENT2_PREVIOUS_COMMIT`), every 2 seconds for 12. Without a brain, a ticket merged with the file declared: the
  conversation showed 工单 1 已合并，这次改动需要部署, and no command ran, no deployment was recorded and nothing answered
  on the toy's port. With the demo brain, unattended: the merge was reported, the brain called `deploy_repository`, the
  toy answered with the merge commit, the conversation showed …已部署到…，健康检查通过, and the ticket was marked deployed;
  a second ticket whose file deployed the broken variant merged, the brain deployed it, seven health checks found no
  answer, the hub ran the rollback with the first commit as `SUPERAGENT2_PREVIOUS_COMMIT`, the toy answered with the
  first commit again, the conversation showed …没有成功，已回滚到…，旧版本恢复正常, and the second ticket stayed
  undeployed. Every process was stopped and the scratch folders removed. Nothing was put in the sandbox repository. Not
  verified live: a held deploy command, a restart in the middle, and a runner or the NAS as the target; the tests cover
  the first two with the real lock and a reopened database.
- **Why:** The fake forge is smaller than a branch in the sandbox, and the toy exercises real processes and a real port.
- **Other options:** The file on a branch of `novan-xu/super-agent-sandbox` with `--credentials environment`.

## 2026-11-17 — A held command's environment is part of what the owner confirms

- **Chosen:** A command's environment is on its record (`CommandRecord.environment`, `{}` when it has none) and in the
  hold's fingerprint, as its entries sorted by name, appended only when there is at least one, so the fingerprint of a
  command without environment is exactly what it was before. Holds stored before this change are of commands without
  environment and stay releasable; a hold whose stored fingerprint does not cover the environment the command now has
  no longer matches and the command is dropped as changed, as a changed command text already is. The confirmation card
  shows the environment below the command, as raw text, `NAME=value` per line in order of name, only when there is one.
  A command's environment can never name a credential (`GH_TOKEN`, `GITHUB_TOKEN`, the account token variables and the
  forwarded Woodpecker and Cloudflare variables, in any case): the command service refuses such a request, since
  credentials are merged in only at run time and would silently win, which the card would misrepresent. The lock reads
  the command text alone; a variable it cannot know in a destructive position (a deletion of a path built from
  `$SUPERAGENT2_PREVIOUS_COMMIT`, `$env:…`, `%…%`, a force-push of `$SUPERAGENT2_COMMIT`) is an unknown target and is
  held, as `rm -rf $DIR` already was; examples are in the held table.
- **Why:** What is confirmed must be exactly what was held and what the owner saw; a rollback's environment decides
  which commit it goes back to. Keeping the old form for an empty environment keeps every hold already waiting valid.
- **Other options:** Dropping every hold stored before the change; letting credential names through and hiding them on
  the card; substituting the variables into the text the lock reads.

## 2026-11-17 — Super-agent2 is deployed by a script that outlives the hub

- **Chosen:** The deploy script on the NAS releases a commit by itself. `deploy.sh begin <deployment> <commit>` records
  the release in `releases/d<deployment>-<commit>/` and starts it with `setsid` in a session of its own, so it survives
  the hub's process, the SSH session that started it and the brain; it returns once the release has recorded its process.
  The release fetches the commit's tarball from GitHub with the token in `secrets/hub.env` (or unpacks an uploaded
  `incoming/<commit>.tar`), builds both images tagged with the commit while the old version runs, stops hub and brain,
  backs up the hub's database with SQLite's `VACUUM INTO` from a one-off container of the running image, switches images
  (`current` becomes `previous`), source (`src` becomes `src.previous`) and its own `deploy.sh` and `compose.yaml` (the
  old ones kept in `deploy.previous/`), starts the hub and waits for `/health` to name the new commit, then starts the
  brain and waits for it to link. On failure it stops both, restores the backup when the database is at a higher
  migration than at the backup (keeping the replaced files in the release's `replaced/`), puts back images, source and
  deploy files, and checks the previous version the same way. `outcome` reads the record, and `settle` waits for the end
  and acknowledges it. `release <commit>` runs the same release by hand in the foreground; `rollback` goes back by hand
  with the backup of the release that switched the running version in. The newest five releases (with their backups) and
  only the images of the running and the previous commit are kept.
- **Why:** The hub that runs the deployment is the thing being replaced, so the health check and the way back have to
  happen outside it. A backup taken after the hub stopped is consistent; restoring it only across a migration keeps what
  the new hub wrote whenever the old hub can still open the database. Building first keeps the downtime to the switch.
  Starting the hub and then the brain with bounded waits avoids Compose waiting without end on a hub that keeps
  restarting. The NAS has no `nohup`, and its `/share/Container` is a symbolic link, so the script keeps the path it was
  called by.
- **Other options:** A one-off container that runs the release (it would need the Docker socket); restoring the database
  on every rollback, which loses what the new hub wrote; letting the hub's own rollback command run the way back, which
  the hub's restart would cut off; uploading the source from a PC as before.

## 2026-11-17 — Super-agent2's deployment file, and why its shape did not change

- **Chosen:** `.superagent2/deployment.json` names the `hub` target and three commands that sign in to the NAS with the
  hub's key and run `deploy.sh begin|outcome|settle "$SUPERAGENT2_DEPLOYMENT" "$SUPERAGENT2_COMMIT"` of the hub's own
  instance, `/share/Container/${SUPERAGENT2_INSTANCE}`, which the Compose file sets in the hub's environment (a command
  on the `hub` target inherits it). The health check runs every 10 seconds for up to an hour. The file's shape from #17
  is unchanged; instead any command of a deployment may print a line
  `superagent2-deployment-outcome {"result", "reason", "previous"?}`, and the hub then ends the deployment with that
  result, whatever the exit code, without running the rollback command; `previous` fills in the version gone back to
  when the hub had none on record. A new result, `unchanged`, says the deployment failed before it replaced anything. A
  deploy command the hub's restart cut off is followed by one health check, and only an outcome line printed by it
  decides; without one the deployment stays `interrupted` as before. The rollback command `settle` remains for a hub that
  never read an outcome; it acknowledges a release that went back, so even a hub from before this change ends with
  `rolled-back` once its period is over.
- **Why:** The hub that starts the first deployment under this scheme is the previous version, which parses the file
  strictly; any new key would make it refuse the very deployment that brings the change. The outcome line is read by
  the new hub after the restart, which is the hub that has to finish the record. Taking the instance from the hub's own
  environment means the same file at the same commit deploys the live system from the live hub and a rehearsal from a
  rehearsal hub, and a hub that names no instance fails rather than reaching the live folder.
- **Other options:** An `outcome` key in the file, refused by every hub before #18; the `nas` target, whose commands
  carry nothing that tells instances apart; letting the health check pass on the previous version, which would record a
  rolled-back deployment as succeeded.

## 2026-11-17 — One deploy script and Compose file for every instance

- **Chosen:** The instance is the name of the folder the script lives in: `superagent2` (live) or `superagent2-<name>`.
  The script exports `SUPERAGENT2_PROJECT`, `SUPERAGENT2_ROOT`, `SUPERAGENT2_HUB_PORT`, `SUPERAGENT2_SOURCE`,
  `SUPERAGENT2_TAG` and `SUPERAGENT2_REVISION`, and `compose.yaml`, now kept next to the script, takes every name, path
  and port from them and refuses to run without them. A folder other than the live one must state `HUB_PORT` in
  `instance.env`. The tunnel's env file is optional, so an instance without a tunnel token starts. `takeover` and
  `giveback` run only for the live folder. A source whose Compose file is from before this change is built with the
  installed one, and its deploy files are not installed. The old `source` and `build` steps are gone; `release` does both.
- **Why:** The rehearsal runs the same files as the live system, so what was rehearsed is what runs.
- **Other options:** A copy of the files per instance; a command-line option for the instance.

## 2026-11-17 — The hub knows its version, and hands it to runners

- **Chosen:** Both images carry `SUPERAGENT2_REVISION`, a build argument the release sets to the commit. The hub reads it
  (a full commit id, or nothing), answers it in `/health`, sends it in its welcome to runners, and with
  `HUB_SOURCE_REPOSITORY` (`novan-xu/super-agent2` in the Compose file) serves `GET /runner/release`: GitHub's tarball
  of that commit, fetched with the repository owner's token and streamed with `x-superagent2-version`, only to a runner
  the front door and its runner token admit. A runner reports its own version in its machine report, and the brain's
  target list says when a runner is not yet at the hub's version. The development harness takes `--announce <commit>`.
- **Why:** The runner needs nothing new to reach the hub's release (no GitHub login on the machine), and gets exactly
  the commit the hub runs.
- **Other options:** `git fetch` on each machine with its own credentials; a package registry.

## 2026-11-17 — How a runner moves to the hub's version

- **Chosen:** A runner whose version differs from the one the hub announces fetches the release into
  `~/.superagent2/versions/<first 12 characters of the commit>`, runs `pnpm install --frozen-lockfile` and
  `pnpm --filter-prod "@super-agent2/runner..." run build` there, checks that `main.js version` reports the commit, and
  marks the folder ready, all while it keeps working. It switches once no worker and no command runs on it: it writes
  `~/.superagent2/version.json` (the version to start, the one before it, and a count of starts not yet confirmed) and
  exits with 75. `install` and `launch` now start `~/.superagent2/start.mjs`, a small generated file that starts the
  version named there; the Windows supervisor restarts the runner at once on 75 and the macOS launch agent restarts it as
  always. The new runner's first welcome from the hub confirms it, refreshes `start.mjs`, and removes every version
  folder but the current and the previous one. `start.mjs` goes back to the previous version after three starts that
  never reached the hub, and that version is not tried again. Any failed step removes what it made, leaves the running
  runner as it is, and is retried after an hour. Only a runner started by its supervisor or launch agent updates itself.
- **Why:** Waiting until nothing runs is the only way to lose no ticket, since a runner's workers are its children; the
  hub already resumes a worker after a runner restart, so a start that races the switch is resumed too. Building in the
  folder it runs from is needed on Windows, where pnpm links the workspace with absolute junctions, so a renamed folder
  cannot start; the short name keeps the paths under Windows' length limit (a 40-character folder failed there).
- **Other options:** Stopping new work on a runner with an update pending; updating the checkout the runner was
  installed from; a Windows scheduled task to restart it.

## 2026-11-17 — What the rehearsal of #18 showed

- **Chosen:** On the NAS, in the Compose project `superagent2-rehearsal` under `/share/Container/superagent2-rehearsal`,
  hub on `127.0.0.1:18190`, no tunnel, with `ACCESS_TEAM`, `ACCESS_AUD`, `OWNER_EMAIL` and `GITHUB_TOKEN_NOVAN_XU`
  copied file to file from the live `hub.env`, an empty `brain.env`, a new SSH key authorized from Docker's networks for
  the rehearsal only, and internal tokens made by the rehearsal hub. `deploy.sh release` of main (`342e96c`) built and
  started it, with this branch's `deploy.sh` and `compose.yaml` (main's Compose file names the live containers). Through
  its brain tools endpoint, `deploy_repository` at this branch's `ba0f488` started deployment 1: the release ran as its
  own session (parent process 1), stopped the main hub during the health check, backed up the database at migration 14
  and switched; the new hub took up deployment 1 ("The hub restarted during the health check"), read the outcome line
  and recorded it succeeded, and the notice "novan-xu/super-agent2 已部署到 ba0f488，健康检查通过" landed in the
  conversation the call named and was taken by the new brain's first turn. Deployment 2 of `4757011`, a throwaway branch
  whose hub applies a migration 15 and then refuses to start: after three minutes without an answer the release went
  back, restored the database from migration 15 to the backup at 14, and started `ba0f488` again, whose `/health` named
  it and whose database opened at 14; that hub recorded deployment 2 as rolled back to `ba0f488` with the release's
  reason, and "novan-xu/super-agent2 部署 4757011 没有成功，已回滚到 ba0f488，旧版本恢复正常" landed in the same
  conversation. With the hub stopped, `release` and then `rollback` by hand moved it to `a1817e8` and back. The
  rehearsal brain had no provider login, so its turns failed after taking the notices; a brain turn answering them was
  not shown. On this PC, a runner in a scratch home, supervised as on Windows, against the development harness
  announcing another commit: it fetched, built and switched in seconds and reconnected at that version; with a 90-second
  command running it reported the version ready and switched in the millisecond the command ended with 0; a commit
  GitHub does not have failed with the hub's 503, and the runner went on and ran the next command. Everything was
  removed afterwards: the rehearsal's containers, volumes, network, images, folder and key, the throwaway branch, the
  scratch runner and the harness. macOS and a runner with a worker running were not exercised live; the tests cover
  them.
- **Why:** The live system was not to be touched, and the rehearsal had to deploy itself through the same file and
  script that the live system uses.
- **Other options:** Copying the brain's Claude token so that a brain turn answers the notice, which the brief did not
  allow for the rehearsal.

## 2026-11-17 — 历史: paging, and what "newest" means

- **Chosen:** A ticket carries `endedAt`, the time of its move into merged, delivered or stopped, stored on the ticket
  (migration 15, filled for existing tickets from their last such move, or their last change when there is none) and
  never changed afterwards. 历史 lists tickets by `endedAt`, newest first, with the ticket number breaking ties. The hub
  reads it with `GET /api/tickets?scope=ended&limit=<1..100, default 30>&before=<cursor>&q=<words>` and answers
  `{ tickets, next }`. The cursor is `<endedAt>.<id>` of the last ticket sent, and the next page is the tickets strictly
  older than it, so a page neither repeats nor skips a ticket however many end between two reads. `next` is null on the
  last page. The page asks for a page when the view is opened, and the owner presses 更多 for each next one; the pages
  already read stay in memory while the owner opens a ticket and comes back. A page read again (when the connection
  returns, or when a ticket ends while a search is shown) is merged into the pages already read, and replaces them only
  when so much ended meanwhile that the new first page no longer reaches them.
- **Why:** `updatedAt` also moves when a merged ticket is marked deployed, and `createdAt` says nothing about when it
  ended; either would reorder the list for reasons the owner cannot see. A cursor on a time and an id stays correct
  while the list grows, which an offset does not. A button needs no scroll listener and cannot load pages the owner did
  not ask for, on a phone with a metered connection.
- **Other options:** Ordering by `updatedAt` or `createdAt`; page numbers or an offset; loading the next page when the
  list is scrolled to its end.

## 2026-11-17 — 历史: what the search matches

- **Chosen:** The words typed are split on any white space (the wide space of Chinese input included), at most eight
  of them, and a ticket is found when each word occurs, as a plain substring, in at least one of: the ticket's title
  and summary in both languages, its repository (`owner/name`), each issue's title and summary in both languages, and a
  writing ticket's task. The hub does this in SQLite with `LIKE` and an escape character, over only the tickets that
  ended, so `%`, `_` and `\` in a word mean themselves. Letters A to Z match their lower case, and nothing else is
  folded: it does not match full-width against half-width forms, accents, or Chinese variants; it does not split Chinese
  into words, so 日期 finds 解析相对日期 but 日 期 with a space needs both characters somewhere, and a word is never
  matched across the end of one text and the start of the next. It does not look at issue numbers, ticket numbers, the
  worker's report, the stop reason, the materials of a writing ticket or what a worker wrote. It scans the ended tickets
  on every search, without an index. The page sends the words as normalised (trimmed, single-spaced) and, while the
  owner is composing with an input method, waits for the composition to end before asking. When a search found a ticket
  by a word its title and repository do not hold, the row shows the part of the issue's text where the word is (a
  writing ticket's task is not sent to the page, so a match on it shows none).
- **Why:** Chinese has no spaces, so any scheme that splits text into words must guess where the words are; a substring
  is what the owner means by typing a few characters of a word they remember, and it is correct for both languages. At a
  few thousand tickets in a personal system a scan is milliseconds, and an index would have to be kept in step with
  every edit of a ticket's texts. FTS5's trigram tokenizer was ruled out because it cannot find a one- or two-character
  word, which is most of Chinese. Showing why a row matched keeps a result that does not show the word from looking
  wrong.
- **Other options:** SQLite FTS5 with the trigram or the unicode61 tokenizer; searching in the page over everything
  loaded; a Chinese word splitter; searching issue numbers too.

## 2026-11-17 — 历史: what is listed, what a row says, and what it does live

- **Chosen:** A ticket that an arrangement joined into another (stopped with the reason "Joined ticket N by an
  arrangement") is not listed; the hub records it as `joinedInto` on the ticket (migration 15 marks the existing ones
  from that reason) and the page leaves it out of 历史 when it arrives live. The ticket is still there by its address.
  A row has the state dot and word in the prototype's fixed hues (已合并 green, 已交付 blue, 已停止 a hollow grey ring),
  the title, the kind, the repository (none for a writing ticket), the issue numbers, when it ended, the pull request
  number, and, for a stopped ticket, the reason the hub recorded, in Chinese, which says who stopped it or why ("你停止了它",
  "引导到上限后，你放弃了它", or what the brain wrote). A stopped ticket with no recorded reason says only 已停止. A ticket
  that ends while the view is open is put into the list at once, in its place by time, in the same change of the page
  that takes it off 工作台; when a search is shown the page asks the hub for the first page again, because it cannot
  check a writing ticket's task. Opening a ticket from 历史 names 历史 on the way back and keeps 历史 marked in the
  navigation; the list, the words in the box and the scroll position are kept by the page, so going back (the link or the
  browser's back) shows the same place. A ticket opened from anywhere else, or by address, goes back to 工作台.
- **Why:** A joined ticket was never worked and was never the owner's decision; its work went on in the ticket it joined,
  which is listed. Listing it would show a stop the owner did not make and repeat the same issues in a search. The
  hue and wording are the prototype's, so a row can be told apart at a glance.
- **Other options:** Listing joined tickets with their own reason; hiding them by matching the reason's text; a filter
  to show them; keeping the list in the address (`?q=`), which would put the words of a search into the browser's history.

## 2026-11-17 — Where memories are kept, and how they reach each program

- **Chosen:** The hub keeps memories in SQLite (migration 16: `memories`, and `memory_changes`, a log of every change
  with its author, its conversation and its text, numbered by a revision). They reach the brain inside the turn's own
  prompt, not through a file: when the brain asks the hub to `prepare` a turn, the answer carries a `memory` brief that
  the brain puts before everything else in the message it gives the program. A session the hub has no record of (a new
  conversation, a provider taking over for the first time, a lost session replaced by a new one) gets the whole memory.
  A session that has seen it gets nothing, unless the memory changed since: then it gets what changed (the owner's
  edits and deletions spelled out; changes the brain made in that same conversation left out, since the session made
  them) and the whole memory again. `program_sessions` records per conversation and provider the revision offered at
  `prepare` and, when that provider's turn ends, the revision seen; a new session starts from none. Checked live
  through the real adapters with `LIVE_STEPS=remembered node tools/brain-live/dist/cli.js <claude|gpt|deepseek>`: a
  memory holding a random code word was stored in the hub, a new conversation asked for it, then the memory was edited
  as the owner and the same session asked again. Claude Code (`claude-opus-5-5`), Codex (`gpt-6-astra`) and `dsh`
  (`deepseek-flash`) each answered the first code word with no tool call, and the new one after the edit; each then
  wrote the English for the owner's Chinese with `remember`. On Windows the check needs `LIVE_CODEX_PROGRAM` and
  `LIVE_DSH_PROGRAM` set to the programs' `.js` entry points, because `spawn` does not run the `.cmd` shims.
- **Why:** The three programs read standing instructions three different ways, and each reads them when a session
  starts; a file would have to be proved per program, would not reach a long-lived session when the owner changes
  something, and is shared by every conversation in the workspace. The prompt is the one input all three take the same
  way, the hub already decides per session what that session has missed, and a takeover already goes through
  `prepare`. The cost is that a program compacting a very long session may summarise the memory away; the brain can
  read it again with `recall`, and any change sends it whole again.
- **Other options:** Writing the memory into the workspace's `AGENTS.md` and `CLAUDE.md` (read only when a session
  starts, and the earlier file Claude Code never read shows the risk); a system prompt option per program, which would
  change the adapters the workers share; sending the whole memory with every turn, which costs its length in every
  message.

## 2026-11-17 — How much the memory holds, and what it refuses

- **Chosen:** At most 30 memories. Each is one line (white space is folded to single spaces), at most 300 characters in
  English and 200 in Chinese, and the Chinese copy must hold Chinese. Adding a 31st is refused with the count and the
  instruction to forget one or merge two (rewrite one with `remember` and its id, forget the other) and add again;
  rewriting is always allowed. A memory saying the same as another, in either language, is refused. A text that looks
  like a credential is refused, from the brain and from the owner alike: the shapes of GitHub, OpenAI and Anthropic,
  Slack, AWS and Google keys, JSON web tokens, private key blocks, `Bearer` tokens and passwords in URLs; a name of the
  kind the hub keeps credentials under (`…TOKEN`, `…SECRET`, `…PASSWORD`, `…API_KEY`, `…PRIVATE_KEY`, `…CLIENT_ID`)
  followed by `=` or `:` and a value; `password:` and `密码是…` and the like; and any value of eight characters or more
  that the hub holds in its environment under a credential's name, its own brain token or its VAPID private key. A
  credential's name alone ("GITHUB_TOKEN_NOVAN_XU is used for novan-xu's repositories") is allowed. The rules are plain
  functions in `packages/protocol/src/memory.ts` and `packages/hub/src/credentials.ts`, with tests.
- **Why:** The memory rides in the first message of every conversation; 30 lines of at most 300 characters stay under
  about 2,500 tokens, small beside the guidance, and are enough for preferences and standing facts when the brain merges
  rather than piles up. A limit the brain is told about makes it curate instead of failing silently.
- **Other options:** A total character budget instead of a count, which is harder for the brain to reason about;
  dropping the oldest memory when full, which would lose something without anyone deciding to.

## 2026-11-17 — The owner's edits, and the English that would go stale

- **Chosen:** The owner edits the Chinese copy, which is what the page shows. The English is kept but marked stale, the
  memory is marked as last written by the owner, and from then on the brain is given the owner's Chinese words, marked
  as such, instead of the stale English. The change notice tells the brain to follow it and to write a matching English
  with `remember` and the memory's id, keeping the owner's Chinese exactly. When the brain does that with the Chinese
  unchanged, the memory stays the owner's and is no longer stale; when the brain changes the Chinese, it becomes the
  brain's. An edit that is the same text after folding white space is no edit. Each edit and deletion names the
  revision the page showed, and is refused when the memory changed since, so an owner's change never silently
  overwrites one the brain made meanwhile. Deleting cannot be undone and is guarded the way stopping a ticket is: the ×
  arms the row, which turns red and offers 删除 and 取消; only 删除 sends it. Both go through `PUT` and `DELETE` on
  `/api/memories/<id>` with the owner's usual checks: the front door's owner, the page's own origin, JSON. The brain is
  told of a deletion with the deleted text and asked not to remember it again unless the owner asks.
- **Why:** The brain never acting on English the owner has already corrected is what makes the page the authority; the
  owner's Chinese is readable to every model. Letting the brain restore the pair keeps GitHub and other models on
  English, as the language rules ask, without the owner writing English.
- **Other options:** Translating the owner's edit in the hub, which has no model; letting the owner edit both languages;
  regenerating the English silently; the prototype's confirmation dialog for deletion, which no other irreversible
  action on this page uses.

## 2026-11-17 — 记忆 on the page

- **Chosen:** One list of the prototype's rows: the Chinese text, a chip saying who last wrote it (大脑 or 你), when it
  was written or last changed, and two icon buttons, 改写 and 删除这条记忆 (names for screen readers and the pointer's
  hover). Newest change first. 改写 opens the prototype's editor in the row with the text in place and only 保存 and
  取消; Enter saves on a keyboard and Escape closes; a text without Chinese or the same as another memory says so under
  the box, and an unchanged or empty one cannot be saved. The list arrives whole on `/ws` after `hello` and again
  whenever the memory changes, so a memory the brain writes appears while 记忆 is open. With none, 还没有记忆. The
  prototype's tabs, pending memories, 摘要, groups and 新记忆 are left out: they belong to parts of the first system this
  design does not have, and the issue gives the owner edit and delete only. The demo brain of `tools/page-dev`
  remembers a message that starts with 记住.
- **Why:** The owner's preference: the layout explains itself, without secondary labels.
- **Other options:** Showing the English as well; an owner's 新记忆 button; showing the count against the limit.

## 2026-11-17 — 设置: sections, addresses and the fold on a phone

- **Chosen:** Five sections, grouped as in the prototype: 执行 (机器, 模型, 仓库), 连接与设备 (连接) and 个人 (外观). The prototype's 规则, 通知, 快捷键 and 文件 sections, and its reviewer, Lark, desktop devices, clients and bridges, are left out. Each section has its own address, `/settings/<machines|models|repositories|connections|appearance>`, defined with the other routes in `packages/protocol/src/page.ts`, so a link or a reload lands on it; `/settings` shows 机器 on a wide screen. Below 1024 pixels the prototype's own rules apply: `/settings` is the section list alone, a section is shown alone with a back link to the list, and the top bar reads 设置 / <section>. The prototype hides the list's labels at that width (the rule meant for the collapsed sidebar also matches the list); `page.css` shows them again, since an icon-only list cannot be read. Everything the page shows comes in one snapshot, `GET /api/settings`, also sent on `/ws` after `hello` and whenever a part of it changes (a runner, a code, the brain's providers, the table, an account, a push subscription).
- **Why:** The issue lists these five and nothing else; one snapshot keeps every open page current, which is what makes a new machine appear the moment it comes online.
- **Other options:** One long page with anchors; addresses in the query string; a request per section.

## 2026-11-17 — How a machine with no credentials reaches the hub to be added

- **Chosen:** One route, `POST /runner/enroll`, is the only path the hub answers without a signed Access assertion. Its only input is the header `x-install-code`; with a valid code it answers the install script, and every other request, path below it or method gets 403 or 404 and nothing else. For the request to get through Cloudflare Access, **the owner adds once, in Cloudflare Zero Trust, a self-hosted Access application for the hub's host name with the path `runner/enroll` and a single policy whose action is Bypass and whose rule includes Everyone.** Access gives a more specific path precedence over the host's own application, and covers that path's subpaths too, which the hub refuses. Nothing else of the front door changes. A code is 32 random bytes, valid for ten minutes (the prototype's 10 分钟), used once: only its SHA-256 is kept (migration 17, `install_codes`), a code is claimed atomically when redeemed and removed once the machine is added, an expired or used code is refused, and asking for a code for the same name again replaces the earlier one. The Access service token is created through `AccessServiceTokens` when the code is redeemed, not when it is asked for, so the hub never holds its secret: it goes once to the machine in the script and only the client id and token id are stored. When Cloudflare fails at that moment the code is released, so the same line can be run again within its ten minutes. 添加机器 refuses at once, with the reason, when the hub has no `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ACCESS_API_TOKEN` (`refusal.cloudflare`) or does not know its own version and source (`refusal.release`), and then nothing is added. The hub's address in the line is the page's own origin, which the same-origin check has already compared with the request's host.
- **Why:** A machine with no service token can pass Access only through a Bypass rule, so the narrowest honest thing is one exact path whose only credential is a short-lived single-use code. Creating the service token at redemption means an unused code leaves nothing behind in Cloudflare and no secret ever rests in the hub. Cloudflare's real API was not called: the create and delete calls are behind the interface and verified with fakes only.
- **Other options:** A second host name for enrolment; a service token shared by all new machines; putting the runner token and service token in the line itself, which is a lasting secret in the terminal's history; creating the service token when the code is made and storing its secret until redeemed.

## 2026-11-17 — How the install line puts the runner on the machine

- **Chosen:** The line is `powershell -NoProfile -Command "irm -Method Post -MaximumRedirection 0 -Headers @{'x-install-code'='<code>'} -Uri '<hub>/runner/enroll' | iex"` on Windows and `/bin/sh -c "$(curl -fsS -X POST -H 'x-install-code: <code>' '<hub>/runner/enroll')"` on macOS. The script the hub answers checks for Node.js 24 or later and pnpm, downloads `GET /runner/release` (the hub's own commit, already served to admitted runners) with the new service token and runner token, unpacks it into `~/.superagent2/versions/<first 12 characters>` (or `SUPERAGENT2_RUNNER_HOME`), writes `.revision`, runs `pnpm install --frozen-lockfile` and builds the runner, passes the setup line to `main.js setup` on standard input, and runs `main.js install`. With `SUPERAGENT2_RUNNER_FOREGROUND=1` it runs `main.js run` instead of installing at login. The script's values are checked to hold only URL-safe characters before they are written into it. Its progress lines are English, as the runner's own command line is.
- **Why:** The hub already serves its exact release to admitted runners, so the machine needs no GitHub login and no checkout; it is admitted as soon as it holds the two credentials the code was redeemed for. Reusing `setup` and `install` keeps the settings file and the start at login exactly as #9 made them, and the version folder is the one #18 updates in place.
- **Other options:** Serving a bootstrap script on a second open route; cloning the repository with the machine's own GitHub login; a packaged runner.

## 2026-11-17 — Revoking a machine from the page

- **Chosen:** 撤销 on a machine's card takes two presses, as stopping a ticket and deleting a memory do: the card turns red and offers 取消 (which takes the focus) and a red 撤销. While armed, when tickets are working on that machine, the card says how many and that they will show 联系不上 that machine and need reassigning or stopping, which is what #11 already does when a runner is lost. `POST /api/machines/<name>/revoke` (owner, same origin, JSON `{}`) marks it revoked, closes its connection, forgets a pending code for that name, and then deletes its Access service token through `AccessServiceTokens.remove`. A failed deletion still revokes and the page says the token was kept; a machine added with an existing token (`--access-client-id`) says the token was not made here and stays in Cloudflare.
- **Why:** A machine whose token is still valid in Cloudflare is still refused by the hub (its runner token is revoked), so the revocation must not wait on Cloudflare.
- **Other options:** Refusing to revoke while tickets run there; a dialog; deleting the token first and revoking only when that succeeds.

## 2026-11-17 — The brain's provider order is kept by the hub

- **Chosen:** The order the page shows and changes is stored by the hub (`brain_order` in `hub_settings`) and sent to the brain as a new hub-to-brain message `order`, at once when it changes and after every `hello`; the brain applies it to its next turn. `BRAIN_PROVIDERS` is only the starting order until the owner changes it. The page orders GPT and Claude (an up arrow moves one earlier); DeepSeek stays last, as the design says. The brain now opens an adapter for all three providers so either order can be followed, and tells the hub, in a new `providers` message after `hello` and on every change, its order and each provider's model, effort and whether it is out until a time; 连接 shows that, with what is left on the matching subscription (GPT with Codex's, Claude with Claude Code's).
- **Why:** The brain's container must not restart, and its environment file is a second process's configuration the hub cannot change; with the hub holding the one stored value and the brain applying what it is told, there is one source of truth and the change reaches the next message.
- **Other options:** Rewriting the brain's environment and restarting it; the brain polling the hub; keeping the order in the brain's workspace.

## 2026-11-17 — 仓库: what is listed and what can be corrected

- **Chosen:** The repositories are derived, never registered: every repository a ticket or a deployment names, and `HUB_SOURCE_REPOSITORY`. Each shows the GitHub account the hub uses for it, by default the account that owns it (else `novan-xu`), and the only thing the owner can change is that account. A correction is kept per repository in lower case (migration 17, `repository_accounts`), choosing the owner's account again removes it, and every place that picks credentials for a repository (work, verification, deployments, the release and filing) now asks the same lookup.
- **Why:** The issue asks for a place to see and correct, not a registry; the account is the one fact about a repository the hub decides.
- **Other options:** A list the owner maintains; editable deployment settings or default branches; the account read-only.

## 2026-11-17 — 模型: what a change is checked against

- **Chosen:** The table is shown by engine (Codex, Claude Code, dsh: a row per difficulty; Antigravity: one row), each row a single select of `model · effort` pairs that some online machine offers for that engine, as on the start card, and 保存. `PUT /api/engine-table` refuses with 422 `unsupported`, changing nothing, when a cell that differs from the stored table names a pair no online machine's program offers; cells left as they were are not checked, so a table whose machines are offline can still be corrected elsewhere. A pair the owner picked stays in the select when the machine offering it goes away, so the save is refused with 没有在线的机器提供 <model> · <effort> instead of silently saving something else.
- **Why:** The design refuses a model a machine does not offer rather than replacing it; checking only changed cells avoids a dead end when a machine is briefly offline.
- **Other options:** Checking every cell; separate model and effort selects as in the prototype; saving on change without a button.

## 2026-11-17 — 外观: kept in the browser and applied before the first paint

- **Chosen:** The choice is the device's: `superagent2.theme` (`system`, `light`, `dark`) and `superagent2.accent` in `localStorage`. A classic script, `/theme.js`, built by Vite as a third entry with no imports and served by the hub like `sw.js`, is the first script in the page's head: it sets `data-theme` and `data-accent` on the root and the `theme-color` meta before the body is parsed, follows the system while the choice is 跟随系统, and applies again on a `storage` event (another tab) and on an event the page sends after a change in the same tab. The accents are the prototype's six presets (琥珀, 青绿, 蓝, 紫, 玫红, 石墨) without its custom colour picker; their tokens are the values the prototype's own contrast routine gives, written once into `page.css`, with the light theme's text colour taken against the page's ground as well as cards, and a test checks that every accent's text reaches 4.5:1 on both grounds in both themes and that its buttons' text does too. A storage that throws falls back to following the system and amber.
- **Why:** The page's policy allows no inline script, so only a separate blocking script can run before the first paint; fixed presets are what keep accent text readable, which an arbitrary colour cannot promise.
- **Other options:** Storing the choice on the hub for every device; applying it from the page's module, which runs after the first paint; the custom colour picker.

## 2026-11-17 — 连接

- **Chosen:** Three groups: the two GitHub accounts, each saying whether the hub has its token (never the token); the brain's providers in order, with model and effort, whether each is available or out until a time, and what is left on its subscription (剩 n%, 已用完 or 额度未知), or 未连接 when the brain is not linked; and the devices subscribed to notifications, named by their push service (Apple, Chrome, Firefox, Edge, 其他浏览器) with the date they subscribed. Devices are listed, not removable here: the issue asks only to show them, and 工作台's 通知 switch already turns a device off.
- **Why:** The endpoint of a subscription is a capability and is not shown; its push service is enough to tell devices apart.
- **Other options:** Storing a device name at subscription; a 撤销 button per device as in the prototype.

## 2026-11-17 — What was verified of 设置

- **Chosen:** In the development harness (`--announce` at this branch's commit, `--credentials environment` for the release, a fake Cloudflare, the demo brain now answering as GPT, Claude and DeepSeek), on this PC, at a desktop and a phone width, in light and dark: 添加机器 on the page gave the Windows line; run in PowerShell with a scratch runner home and `SUPERAGENT2_RUNNER_FOREGROUND=1`, it fetched the hub's release, built it, saved the settings and connected, and the machine appeared online in 机器 without a reload. A first run under the scratch folder failed in `pnpm` with a path too long for Windows, so the scratch home was moved to a short folder; owners install into `~/.superagent2`, which is short. The same code sent again, and a code left for more than ten minutes, were refused with 403. 撤销 armed the card, revoking closed the runner's connection (4003) and its next connection was refused with 403; with the fake Cloudflare refusing deletions the page said the token was kept. Moving Claude ahead of GPT made the next message's turn run on Claude (the one before ran on GPT). Changing Codex 复杂 to `gpt-6.1-sol · xhigh` changed the start card of an arranged complex Codex ticket, and `choose_defaults` reported it; a table naming `gpt-99` was refused with 422 and the table did not change. The theme and accent changed at once, a second open tab followed, a reload kept them with `/theme.js` loaded before the page's module, and 跟随系统 followed the browser's switch between light and dark. Nothing was installed to start at login, and the scratch runner, its folder and the harness were removed afterwards. Cloudflare's real API, the Bypass rule and macOS were not exercised.
- **Why:** These are the issue's "Done when" items and the points the brief asked to see.
- **Other options:** None.

## 2026-11-17 — The build is complete, and what is left for the owner

- **Chosen:** With #21 merged, every issue is built except #8, which stays open until the owner has signed in to the
  page and talked to the brain. The live system was moved to the last commit by hand, with the first release under the
  scheme of #18; from here the brain can deploy Super-agent2 with `deploy_repository`. Nothing was changed in
  Cloudflare: adding a machine from the page needs an Access application for the path `runner/enroll` with a Bypass
  policy, and runners need a Service Auth policy on the host's application. Both are the owner's to add.
- **Why:** Those two rules open paths through the owner's front door, and no issue asked for them to be made without
  the owner. Until they exist, no machine is connected to the live hub, so a started ticket waits for a machine.
- **Other options:** Create the rules through Cloudflare's API with the hub's token.

## 2026-11-17 — The brain starts with Claude, then GPT

- **Chosen:** At the owner's review, the starting order is Claude, then GPT, then DeepSeek only while both are
  unavailable. It is stated once, as `startingOrder` in `packages/protocol/src/settings.ts`, and read by the brain's
  `BRAIN_PROVIDERS` default, by 设置 before the brain has linked, and by the development harness's demo brain;
  `tools/brain-live`'s failover check now makes Claude unavailable first. This overturns the default `gpt,claude` in
  "The brain as a package of its own". The hub never writes `brain_order` by itself: the row exists only after the
  owner pressed 提前 in 设置 → 模型, so it always holds an order the owner chose, and nothing migrates it. On the live
  system the new default applies when the next deployment recreates the brain container, unless the owner has chosen an
  order in 设置 (that order stays) or `secrets/brain.env` on the NAS sets `BRAIN_PROVIDERS` (that value wins over the
  default and has to be removed or changed by hand).
- **Why:** The owner's word. Seeding the hub's row from a default would make an untouched order look like the owner's
  choice, and a migration to correct it could overwrite one the owner made.
- **Other options:** A migration that rewrites a stored `gpt,claude`; setting `BRAIN_PROVIDERS` in `deploy/compose.yaml`.

## 2026-11-17 — 确认 and 拒绝 on a held command take one press

- **Chosen:** At the owner's review, 确认 releases a held command at once and 拒绝 refuses it at once; the buttons stay
  where they are. This overturns the two presses of "What a confirmation card shows and how 确认 is guarded". The
  page's refusal of a second answer for the same card, the disabled buttons while an answer is on its way, and the
  fingerprint the owner saw are unchanged. Arming now exists only for a stuck ticket's 放弃, and the reducer refuses to
  arm any other card.
- **Why:** The owner finds the second press unnecessary; the card itself, showing the whole command, is the guard.
- **Other options:** Keeping two presses for some forms of hold only; a press-and-hold button.

## 2026-11-17 — A held command's notification names the target and the command

- **Chosen:** At the owner's review, the notification for a held command reads `<target> 上有一条命令等你确认：`
  followed by the command on the next line; the title, the tag and the address are as before. This overturns "holds no
  command" in "When the hub sends, and what a notification says". The whole payload must fit one Web Push record of
  4096 bytes, which leaves 3993 bytes of JSON; a longer command is cut at a whole character, found by halving, and ends
  with `…`. If even the target and the ellipsis did not fit, the plain sentence 有一条命令等你确认 is sent, so a
  notification always goes. The command's environment, its account and its folder are never in the notification: a
  value under any name could be a credential, and the command service still refuses credential names as variables.
- **Why:** The owner accepts the command on the lock screen of a personal device; leaving out the environment entirely
  is the only way to be sure no credential value reaches a push service.
- **Other options:** Showing the environment with values that look like credentials masked; cutting by bytes; naming
  the form of the hold instead of the command.

## 2026-11-17 — Four selects on the start card, and one name for the provider

- **Chosen:** At the owner's review, the start card has four selects in the order 机器, 供应商, 模型, 推理强度; the
  model select lists the models the chosen machine's program offers, and the effort select the efforts of the chosen
  model. Each field keeps its own `field--owner` mark. Changing the provider returns model and effort to the table's, as
  before; changing the model keeps the effort when the new model offers it, and otherwise returns an effort the owner
  set to the default; changing the machine drops the owner's model and effort when the machine does not offer the
  model, and only the owner's effort when it offers the model but not that effort. `resolveStart` now says `effort` is
  missing (机器上的程序不给这个模型提供这个推理强度) when the model is offered and the effort is not, and `model` only
  when the model is not offered. 改派 in the ticket's panel has the same four selects, with 按默认 for the model, and asks
  for an effort once a model is picked. The page calls the program 供应商 everywhere it names it: the start card, 改派,
  the ticket's detail, and the messages about what is missing; 设置 names each program by its own name and had no
  general word for it. This overturns the three selects of "The choice on the start card".
- **Why:** The owner's word, and one thing has one name.
- **Other options:** Leaving 改派 with one select of pairs; choosing the new model's first effort when the old one is not
  offered, which the design forbids as taking a neighbour.

## 2026-11-17 — Nothing the owner, the brain or a worker sends has a cap of its own

- **Chosen:** At the owner's review, every cap on what is sent was removed: the owner's message to the brain (100000
  characters), a message to a worker (20000 characters, 64 KB body), the words on a stuck card (4000), a writing task
  (20000), material (500-character source, 200000 characters a piece, 20 pieces, 400000 together), `merge_ticket`'s
  reason (2000), `arrange_chains` (100 chains, 100 issues, 100 before), `choose_defaults` (100 chains, 100 issues), a
  start (200 chains), a deployment's deploy, rollback and health commands (20000 each), a deployment outcome's reason
  (4000), a command's environment value (10000), the writing worker's deliverables (20 files, 4 MB each, 8 MB together,
  200000 characters of text) and the corrections of a hand-back (two, then the attempt failed; now the worker is told
  what is wrong for as long as it is wrong). This overturns those limits in "A writing ticket's task and material", "The
  scratch folder and the hand-back of a writing worker" and "Delivering the text and files into the conversation".
  What remains is physical. A request body read into memory, and so one live message, is at most 64 MiB
  (`largestMessageBytes`): a request that declares more is answered 413 `too_large` once the sender is known, and the
  page says 超过了系统一次能传送的物理上限（64 兆字节）, while a body sent without its length that runs past it is a 400.
  The `ws` library's own frame limit of 100 MiB stays above it, and SQLite's limit of about a billion bytes a value is
  not reached. A text result whose JSON is larger than 64 MiB reaches the owner whole, as a file, instead of inline.
  A command longer than a shell accepts fails with the operating system's own error, as any command already did. Left
  as they are, with the reason: the memory limits (reworked separately); `roundCap`; every clip of a log or output
  handed to an LLM or listed on the page (the full text stays); deployments' health-check timing; name and identifier
  fields (machine, model, effort, variable, chain and material names, a delivered file's name, a commit, a deployment's
  folder, push subscriptions); network timeouts; page sizes of lists and of `list_tickets` (a read, not something
  sent); 历史's search of 200 characters and 8 terms (each term is one more pattern matched against every ended ticket);
  the hub's internal scans of up to 100000 open tickets; the lock's nesting depth of 8 when it reads a command; the
  brain's four open programs; the runner's three trial starts and its 5 MB log.
- **Why:** The owner asked for no upper limit except where the mechanism itself would break; 64 MiB keeps one message
  well inside the WebSocket frame limit with room for its envelope and escaping.
- **Other options:** Raising each cap to a larger number; one limit for the brain and another for the owner; streaming
  request bodies to disk so that no request has a limit.

## 2026-11-17 — Delivered files travel in parts the hub asks for

- **Chosen:** The `delivered` event now carries each file's name, size and media type, and no bytes. While the ticket
  stays working and the attempt running, the hub asks the runner for each file in parts of 8 MiB (`work.file`, answered
  by `work.file.part` with the bytes in base64, or none and the reason), one part at a time over the link it already
  has, and writes them to `<HUB_DATA_DIR>/files/t<ticket>/a<attempt>/<index>`. When every file is whole it finishes the
  attempt, records the files, and delivers into the conversation as before. After a dropped link or a restart of the hub
  it goes on from the size it already has when the runner says hello; a part the runner cannot read ends the attempt as
  `lost`, a failure of the machine with its one uncounted retry. A stop or a new attempt drops what was fetched.
  `ticket_files` (migration 19) keeps the bytes of files delivered before, and new rows point at the fetched files,
  which `GET /api/tickets/<n>/files/<name>` streams. A runner still on the version before this asks nothing new of the
  hub, but it closes its link on `work.file`; it switches to the hub's version as soon as its work has ended, and then
  answers.
- **Why:** Base64 inside one event and a blob in SQLite carried the whole file through memory at every step. Parts the
  hub pulls need no new route through the front door, no retry logic in the runner, and stay far below Cloudflare's
  limit on one request.
- **Other options:** The runner uploading each file over HTTP, which through Cloudflare needs parts anyway and a way to
  retry after a dropped link; parts as ordinary work events in the runner's ledger, which would copy every file into it.

## 2026-11-17 — A merge conflict goes back to the worker every time

- **Chosen:** At the owner's review, every time verification finds the pull request conflicting, it goes back to the
  worker with a note to merge the base, resolve, test, push and hand back, naming the files changed on both sides and,
  from the second time, how many times it has come back. It is never a failure: it counts toward no round and never
  makes the ticket stuck. This overturns "sent back only once" in "A conflict at merge time" and the `conflict` failure
  of "What a failure is, and what counts as a guided round". `conflict` is no longer a failure kind; migration 18 drops
  `ticket_verifications.conflict_head`, adds `conflict_returns`, and rewrites any stored conflict failure as a red
  workflow, which keeps an old row readable (none can exist on the live system, where no worker has run). The count is
  raised only when the ticket actually went back, is on the ticket as `verification.conflictReturns`, and `read_ticket`
  says "went back to its worker for a conflict n times". The brain is not told at each return; it steps in with
  `message_worker` while the worker runs, since `guide_ticket` answers failures only. Verification's `conflict` state
  stays, as the record that the head conflicted, or that it could not go back to the worker.
- **Why:** The owner's word: the worker resolves the conflict, however long it takes.
- **Other options:** Telling the brain at each return; a count on the ticket's own row; keeping `conflict` as a failure
  kind that is never counted.

## 2026-11-17 — dsh takes a message into a running turn, and stops one without being killed

- **Chosen:** A plugin of our own, `packages/programs/src/dsh-control.ts`, built with the package to
  `dist/dsh-control.js`, adds steering and cancelling to dsh's `sdk` profile. The adapter mounts it through the `--patch`
  file it already writes, by the plugin's absolute path, with a path for a local channel in the plugin's config: a named
  pipe on Windows, a Unix socket in the temporary folder elsewhere. The adapter listens on that path before it starts dsh;
  the plugin connects when dsh loads it, and the two speak JSON-RPC lines over it. `steer` calls the dsh agent's own
  `steer`, which dsh feeds into the running turn at its next step; the plugin does it only while that session's turn is
  open (between `turn/start` and `turn/end`) and its agent is running, and otherwise answers that it is idle, so the
  adapter reports the message as queued and the brain or runner starts the next turn with it, as before. `cancel` calls
  the agent's `cancel` as the user; dsh ends the turn as `aborted`, which the adapter reports as interrupted, and the
  process and session stay for the next turn. The adapter sends the cancel only once the prompt has reached dsh; an
  interrupt that comes earlier keeps the prompt from being sent. The program is killed, and the session resumed in a new
  process, only when the cancel is not acknowledged: no plugin connection, an error, or a closed channel. If dsh goes
  idle after a cancel without ending a turn, the adapter ends it as interrupted. A second interrupt of the same turn is
  ignored. This overturns the part of "What the programs cannot do, and the nearest honest behaviour" about dsh (no
  message into a running turn, no interrupt) and the choice in "How each program is driven" not to write a dsh control
  plugin.
- **Why:** The owner asked for both. The `sdk` profile stays, so failures keep their error codes for choosing a
  provider. dsh loads plugins from a path in a patch row, so one file in this repository gives both features wherever
  the adapter runs: in the brain's container and on every runner, with nothing for the owner to install, and the patch
  that mounts it is written per launch, so the owner's own dsh profiles are never touched. A channel the adapter owns
  needs no port and no discovery, and passing its path in the patch keeps it out of the environment that dsh's tools
  see. Tracking the open turn in the plugin closes the race where a message arrives as a turn ends: dsh drains steering
  given before `turn/end` inside that turn, and anything later becomes a turn of its own.
- **Other options:** `dsh --profile acp`, whose `session/cancel` is native, plus a plugin only for steering: one prompt
  at a time per session, and failures arrive as text only. A local HTTP port announced on standard error: a port to
  allocate and protect. Interrupting a dsh turn and resending the message as a new turn.
- **What a dsh update can break:** The plugin relies on interfaces dsh documents in its type files but does not promise:
  plugins loaded from an absolute path in a `--patch` `insert` row with their `config`, the `agents` service
  (`ctx.agents.get(sessionId)`), an agent's `status`, `steer(message)` and `cancel({ kind: "user" })`, and the
  `session/event` hook with `turn/start` and `turn/end`. If a newer dsh fails to load the plugin, it logs the error and
  runs without it, and the adapter falls back to queueing and killing. The brain's image pins dsh 0.2.1-rc.2; a runner
  uses whichever dsh its machine has.

## 2026-11-17 — Credentials are out of the confirmation lock

- **Chosen:** The lock has five forms: `repository-deletion`, `repository-publication`, `default-branch-rewrite`,
  `data-deletion` and `file-deletion`. `credential-change` is gone, with its command rules (`gh secret`, `gh auth
  logout`, deleting SSH, GPG and deploy keys, `docker secret rm`, `kubectl delete secret`, `wrangler secret`,
  `cloudflared tunnel delete`, `woodpecker-cli secret`, `gpg --delete-*`, `security delete-*`, `cmdkey /delete`), its API
  rules (secrets, keys, tokens, grants, Cloudflare tokens, service tokens and tunnels), the effect rule over credential
  files with its built-in list of credential paths, `HUB_CREDENTIAL_PATHS` (and `credentialPaths` in the hub's
  configuration, `deploy/compose.yaml` and the harnesses) and the project `.env` exemption that only softened it. What
  became dead went with them: the hub no longer reads what a command writes, copies or moves (redirects, `cp`, `mv`,
  `tee`, `sed -i`, `ssh-keygen`, `openssl`, PowerShell's `Set-Content` and `Out-File` and the rest), only what it
  deletes, pushes or sends to an API; the Cloudflare API is no longer read at all. This overturns the forms of "How the
  confirmation lock reads a command" (six forms, and rules over what a command writes or moves), "Project folders and
  credential paths" (`HUB_CREDENTIAL_PATHS`, the built-in credential list and everything it held), "Temporary folders and
  a project's own `.env`" (the project `.env` exemption, and the credential file in a temporary folder that stayed held)
  and "Project folders and credential paths in the deployment" (the value of `HUB_CREDENTIAL_PATHS`); those entries stay
  as written, and what they say of project folders and temporary folders still holds. The consequences: writing,
  appending to, overwriting or moving a credential file is not held anywhere. Deleting one is judged only by
  `file-deletion`, like any other file, with no special case either way: held outside the project folders and the
  temporary folders, free inside them, so a credential file in `/tmp` is now deleted without a hold. The other five
  forms are unchanged. Not touched, because they are not this form: the refusal of credential names as a command's
  environment variables, the refusal of credential-looking text in a memory, the way the hub injects credentials into
  commands, and `packages/hub/src/credentials.ts`. The brain's guidance no longer lists credentials among what is held,
  and `docs/design.md` says credentials are not on the list. A deployment that still sets `HUB_CREDENTIAL_PATHS` is not
  refused: the hub ignores a variable it does not read.
- **Why:** The owner's word: changing or deleting credentials is not within the confirmation lock's scope.
- **Other options:** Keeping the lock's reading of writes and moves for a later form; holding a credential file's
  deletion wherever it is; leaving `HUB_CREDENTIAL_PATHS` accepted and unused.

## 2026-11-17 — The brain's reach ends at the hub's container

- **Chosen:** At the owner's review, the hub has no way into the NAS host. The `nas` target is gone, with
  `NAS_SSH_DESTINATION`, `NAS_SSH_PORT` and `NAS_SSH_IDENTITY` (a hub given them ignores them), the SSH script target
  behind it, the key's mount at `/run/superagent2/ssh`, the `host.docker.internal` host entry and `SUPERAGENT2_INSTANCE`
  in `deploy/compose.yaml`, and the `authorize` step and the key generation of the `secrets` step in `deploy/deploy.sh`.
  `deauthorize` stays, so an instance authorized earlier can be cleaned up, and now refuses a public key file that holds
  no key instead of matching every line. The hub does not deploy Super-agent2: `.superagent2/deployment.json` is
  removed from this repository, `deploy_repository` refuses the hub's own repository (`HUB_SOURCE_REPOSITORY`) before
  it reads GitHub, whatever an older commit's file says, and a merge in it tells the brain that the new version waits
  to be deployed on the NAS, with 工单 n 已合并，Super-agent2 的新版本等你部署 as the notice. The owner deploys it with
  `deploy.sh release`, or files work for a worker, which signs in with its own machine's access; the brain then records
  it with `report_deployment`. A deployment file of any repository that names `nas` is refused with the reason that the
  hub cannot reach the NAS host. `nas` stays reserved as a machine name, so no runner can take it and turn such a file
  into a deployment on that runner. The script's `begin`, `outcome` and `settle` steps and the background release they
  started are removed, since only the hub called them; `release`, `rollback` and the other steps keep today's
  behaviour, including installing the release's own `deploy.sh` and `compose.yaml`. The hub's reading of an outcome
  line from a deployment's commands stays, as a general part of `deploy_repository` that its tool text describes.
  Runner targets, for `run_command` and for deployment files, are unchanged. This overturns "How the hub reaches the
  NAS host", the `nas` part of "Targets, shells and stopping", "Super-agent2's deployment file, and why its shape did
  not change", and the hub-driven part of "Super-agent2 is deployed by a script that outlives the hub" (`begin`,
  `outcome`, `settle` and `setsid`); the release itself, with its backup, health check and way back, stands.
- **Why:** The owner's word: administrator rights inside this project's containers are intended, administrator rights
  over the whole NAS are not. `novanxu` can drive Docker for every container on the NAS, so any sign-in as that user is
  the whole NAS, and the brain has passwordless `sudo` in the hub's container, so whatever the container holds the brain
  holds. Whether the brain deploys Super-agent2 matters little to the owner, since a worker can.
- **Other options:** A key that `sshd` restricts to a forced command accepting only the release's verbs, kept for the
  self-deployment; a NAS user without Docker rights, which could not release; keeping `nas` as a target name that is
  listed and always refused.

## 2026-11-17 — The memory is the owner's, in one Chinese text

- **Chosen:** A memory has one text, in Chinese, which is what 记忆 shows and exactly what the brain is given. The English
  copy, the stale mark and the "write a matching English with `remember`" round trip are gone. This is a stated
  exception to the rule that text an LLM generates for the owner is kept twice (`GeneratedText {en, zh}`): a memory is
  the owner's own text, and the brain reads Chinese directly. Migration 20 drops `text_en` and `stale` from `memories`
  and renames `text_zh` to `text`, so each existing memory keeps its Chinese words and its id; it renames the change
  log's old actions (`remembered` to `added`, `rewritten` to `edited`) and resets every session's memory mark, so each
  running session is given the whole memory again at its next turn, with the note that it replaces any memory given
  before. Overturns the English half of "Where memories are kept, and how they reach each program" and the whole of "The
  owner's edits, and the English that would go stale".
- **Why:** The owner's words: the memory page always shows Chinese, no translation is needed, and the brain reads
  Chinese without trouble. The pair cost a round trip after every edit and gave two texts that could disagree.
- **Other options:** Keeping an English copy for other models (every model in use reads Chinese, and a memory never
  goes to GitHub); translating in the hub, which has no model.

## 2026-11-17 — The owner's edits are stored exactly as written

- **Chosen:** What the owner saves is stored as it is: no length or count limit, no "must contain Chinese", no duplicate
  refusal, no credential refusal, no white-space folding or trimming. Line breaks are kept; the page shows them
  (`white-space: pre-wrap`), and the brain is given each text as a quoted JSON string, so line breaks and spaces reach it
  exactly. A blank box is simply not saved: 保存 is disabled on the page, and the hub answers 400 to a text of white
  space only. The owner also adds a memory by hand (`POST /api/memories`). The revision check on edits and deletions is
  dropped: only the owner changes the memory now, so the only possible conflict is between two of the owner's own
  devices, where the last save winning is what the owner expects and a refusal would restrict the owner's edit; the
  list is live on both devices anyway. An edit or deletion of a memory already gone answers 404. Overturns, for the
  owner, every limit and refusal of "How much the memory holds, and what it refuses", and the revision part of "The
  owner's edits, and the English that would go stale".
- **Why:** The owner's words: no restriction on my own edits; whatever I write, however I change it, that is exactly
  what gets stored. A credential the owner chooses to write is the owner's decision, though the memory is sent to the
  model providers with each conversation.
- **Other options:** Keeping the credential refusal for the owner as a warning to confirm; keeping the revision check
  with a merge prompt.

## 2026-11-17 — The brain only suggests

- **Chosen:** `remember` creates a suggestion (`memory_suggestions`, migration 20) and changes nothing else; `forget`
  creates a suggestion to remove a memory. Both wait in 记忆's 待确认, where one press of 确认 or 不要 decides them. A
  `remember` suggestion may name in `replaces` the memories it replaces: the page shows them struck through after
  确认后替换, and 确认 adds the new memory (its chip says 大脑) and removes those still there; a replaced memory already
  deleted is skipped. A `forget` suggestion shows the memory struck through after 确认后删除 (the prototype has no
  forget suggestion; this follows its replace line). When the owner deletes a memory, a pending suggestion to forget it
  is settled and leaves 待确认. The nav item 记忆 shows the count of pending suggestions, in the sidebar and the tab bar.
  No push notification is sent: nothing waits on a suggestion. This holds when the owner says 记住… in the
  conversation too: the hub cannot tell who asked for a suggestion, so every one waits for 确认. The brain has no way to
  withdraw a suggestion; the owner declines one that is no longer wanted. Every answer of `remember`, `forget` and
  `recall` carries the memory as it is now, the pending suggestions and what the owner set aside.
- **Why:** The owner's words: I manage the memory myself, the brain only makes suggestions. A write the owner did not
  confirm is what let repeated and unwanted memories in.
- **Other options:** Writing at once when the owner asked in words, which the hub cannot verify; a push notification
  per suggestion; a `withdraw` tool for the brain.

## 2026-11-17 — What counts as the same text, and what the brain is not to suggest again

- **Chosen:** Two texts are the same when their keys are equal. The key (`memoryKey` in
  `packages/protocol/src/memory.ts`) is the text after Unicode NFKC (full-width letters, digits and punctuation become
  their ordinary forms), lower-cased, with every white-space character (the ideographic space and line breaks
  included), every punctuation mark (Chinese and Western, in either width) and every invisible format character
  removed. Symbols, digits and every other character count, so 每周 1 次 and 每周 2 次, or C++ and C, stay different.
  The hub refuses a `remember` whose key equals that of a memory, of a pending suggestion, of a suggestion the owner
  declined (不要), or of a memory the owner deleted (with ×, by confirming a `forget`, or by confirming a suggestion that
  replaced it); the refusal names what it matched, with its id and text. A `forget` is refused while one for the same
  memory waits, and after the owner declined forgetting that memory, until its text changes. `ownerAsked: true` lifts
  only the refusals for what the owner declined, deleted or kept, for when the owner asks for it again; never the one
  for a memory or a pending suggestion. The brain is given, with its memory at the start of each conversation, in every
  change notice and in every `recall`, `remember` and `forget` answer, the pending suggestions and what the owner set
  aside, marked as not to be suggested again unless the owner asks. A set-aside text is listed once, and not while a
  memory says it again. The texts a memory had before the owner edited it are not set aside.
- **Why:** Repeated suggestions are the owner's main complaint about the earlier system, so the rules carry what rules
  can: the same text, in any spacing, punctuation, width or case, cannot come back. Chinese is written without spaces
  between words, and a stop or a comma, its width, or the case of a name does not change what a sentence says. Rules
  cannot catch two wordings of one meaning (你希望回答简短 and 回答尽量短一些); that part is the brain's judgement, helped
  by always seeing the memory, the pending suggestions and the set-aside list, and by the guidance and the tool's
  description telling it to name the memory it updates in `replaces`. No other model is used as a judge. The set-aside
  list grows without bound and is sent whole; no cap is added.
- **Other options:** Exact comparison only (misses 。 against no stop); removing symbols too (C++ and C would match);
  similarity by edit distance or by a model, which would refuse real new memories on a guess.

## 2026-11-17 — Limits on the brain's suggestions

- **Chosen:** No count cap and no length cap. A suggestion must contain Chinese (a Han character), so that the page
  stays Chinese; names and technical terms may be in any script. A suggestion that looks like a credential is refused,
  by the same rules as before (`packages/hub/src/credentials.ts`). The brain's text is trimmed at both ends; the
  owner's never is.
- **Why:** The owner asked for no caps. The credential refusal is a constraint on the model's behaviour, and the memory
  is sent to model providers with every conversation. The Chinese check is the code side of "the memory page always
  shows Chinese" for text the brain writes.
- **Other options:** Leaving the language to the guidance alone.

## 2026-11-17 — 记忆 on the page, with suggestions and 新记忆

- **Chosen:** Two sections, as in the prototype: 待确认 with a hot count, then 长期记忆 with its count, each newest
  first; a section with nothing in it is not shown, and with neither, 还没有记忆. A suggestion row shows its text, what
  it would replace or remove struck through, when it was made, and 确认 and 不要; no source chip. 新记忆 in the top bar
  opens the prototype's editor at the top of the page, empty. The editor has no length limit and shows no message under
  the box; 保存 is disabled while the box is blank or unchanged; Enter saves on a keyboard, Shift+Enter starts a new
  line, Escape closes. Deleting is unchanged: × arms the row, 删除 sends. No tabs, no 摘要, no kind groups. The demo
  brain of `tools/page-dev` suggests on 记住… (with 替换 #n to replace a memory) and on 忘掉 #n. Partly overturns "记忆
  on the page" (its single list, its messages under the box, and the 新记忆 it left out).
- **Why:** The prototype's look, with the owner's wish for the pending flow and for writing a memory by hand.
- **Other options:** A link from each suggestion to the conversation it came from; a modal editor for 新记忆.

## 2026-11-17 — A chain is handed in as several pull requests

- **Chosen:** The worker owns the chain and decides how many pull requests to open. Whenever a piece is ready it opens a
  pull request and hands it in with the same file as before, `{"pullRequest", "summary"}`; its turn ends there and it
  waits, as the owner chose. The runner accepts a hand-in when GitHub says the pull request is open (or merged), comes
  from the ticket's current branch, and closes at least one issue of the chain that no merged pull request of the
  ticket has closed; otherwise it tells the worker what is wrong, as a wrong hand-back is corrected today. A turn that
  ends with no hand-in while issues are open is told which are open. The runner's `finished` event now carries the
  issues the pull request means to close, as GitHub listed them at the hand-in, which the page shows for an open pull
  request; the hub never relies on it (see the next entries). This overturns "How a worker hands back its result"
  (a pull request had to close every issue) and "What a worker is told" (one pull request for the chain).
- **Why:** The owner's model: an issue is the unit, a chain is a list handed to one worker at once, and the worker
  decides how to cut it. Requiring each hand-in to close an open issue catches a missing `Closes #n` before the merge,
  when it can still be fixed by editing the body; after the merge it would need an extra pull request.
- **Other options:** A `finished` flag in the hand-back file; accepting a pull request that closes nothing (a
  preparatory refactor), which is allowed only by folding it into the issue it serves.

## 2026-11-17 — Branches for the pieces of a chain, and which pull request is the ticket's

- **Chosen:** Each piece has its own branch, named by the hub as before (`sa2/ticket-<n>-<four hex digits>`, a new
  random part each time) and stored as the ticket's current branch when the piece starts. The merged branch is deleted
  on GitHub as before. The runner moves the ticket's one worktree to the new branch in place, `git switch
  --discard-changes --no-track -C <new> origin/<default>` after `git fetch --prune`, so the folder, its ignored files
  (installed dependencies, build output) and the program's session stay; it deletes the previous local branch when it
  is a hub branch that no longer exists on GitHub. When switching fails the worktree is made again from scratch, as
  before. A pull request is the ticket's when its worker hands it in from the ticket's current branch; a different
  pull request handed in from the same branch marks the earlier open one `closed` in the record. This overturns, in
  "Where a worker works on a runner", that one branch serves every attempt of a ticket.
- **Why:** A fresh branch from the updated default branch is what the next piece needs, and a new name keeps each
  merged pull request's branch distinct in GitHub's history. Recognising the pull request by the hand-in and the
  current branch needs no labels or naming rule the worker could get wrong.
- **Other options:** Reusing the same branch name after it was deleted; letting the worker name its branches under a
  ticket prefix; recreating the worktree for every piece.

## 2026-11-17 — Continuing after a merge is done by the hub, in the same session

- **Chosen:** When a handed-in pull request merges and issues of the chain are still open, the verification service
  records the pull request as merged with the issues it closed and calls `WorkService.onward`. In one transaction it
  moves the ticket from verifying to working ("PR #n 已合并，接着做 #a、#b"), deletes the verification record, sets the
  new branch, sets the guided-round count to zero and inserts the next attempt, which resumes the program's session on
  the same machine and engine in the same folder. Its note says which pull request merged and as which commit, which
  issues it closed, which are closed so far, which remain with their titles and links, and the new branch made from the
  updated default branch. No message goes to the brain. If it cannot continue (no machine chosen, say), the ticket
  stays verifying with the reason, the brain is told once, and every check tries again. While the worker waits for a
  merge it holds no slot on its machine; the next piece queues like any start when the machine is full.
- **Why:** The owner wants no blocking point and one press of 开始 per chain. Each step is recorded and repeatable, so a
  restart between the merge and the continuation finishes it at the next check, as a merge already is.
- **Other options:** Keeping the attempt open across the wait (an attempt state that holds a slot and has to survive
  restarts); telling the brain and letting it continue the worker.

## 2026-11-17 — Which issues a pull request closed, and when a chain is done

- **Chosen:** The hub reads the pull request's closing references from GitHub's GraphQL API (`closingIssuesReferences`,
  paged, the same repository only) immediately before each merge, and again after a merge it did not make when none
  was read for that head. It closes only those issues of the chain that are still open, not every issue of the chain.
  The chain is done, and the ticket moves to merged, when every issue of the chain is closed by a merged pull request of
  the ticket; an issue closed by hand does not count. A merged pull request that closed none of the open issues (its
  body was edited after the hand-in, or the owner merged it on GitHub) is recorded with no issues, and the worker
  continues with all that remain. This overturns, in "How the merge is done, exactly once", closing every issue of the
  chain at the merge.
- **Why:** The issue asks that the closed issues come from GitHub, not from the worker's file. Reading at the merge
  rather than at the hand-in follows a body edited during a failure round.
- **Other options:** Parsing `Closes #n` out of the pull request body; trusting the list the runner read at the hand-in.

## 2026-11-17 — The record of a chain's pull requests

- **Chosen:** Migration 21 adds `ticket_pull_requests`: per ticket, in the order handed in, the number, link, branch,
  state (`open`, `merged`, `closed`), the issues it closes (for a merged one, as read at the merge), merge commit,
  whether the repository had a deployment at that commit, and when it was handed in and merged; and
  `ticket_verifications.closes`. `Ticket.pullRequests` carries the records, `Ticket.pullRequest` stays the latest, and
  `mergedIssueNumbers`, `openIssueNumbers` and `openPullRequest` in the protocol derive the rest. The last pull
  request's verification record stays with the merged ticket, so its merge commit is the ticket's for deployments.
  For the live database, the migration gives every ticket with a pull request one record: merged, closing every issue
  of its chain, with the merge commit and deployment flag of its verification, when the ticket is merged; open, closing
  nothing yet, otherwise. A ticket working or verifying when the hub is updated continues under the new rules; its pull
  request was made to close every issue, so it ends merged as it would have.
- **Why:** The owner and the brain need to see which issues are merged and which pull requests exist; a later repair
  ticket takes over exactly the open pull request and the open issues of a stopped chain.
- **Other options:** JSON on the ticket row; deriving merged issues from GitHub on every read.

## 2026-11-17 — The guided-round count across a chain's pull requests

- **Chosen:** A merged pull request resets the count and the free retry to zero, in the transaction that starts the next
  piece. Rounds stay recorded in `ticket_rounds`. This overturns, in "Where the count lives, and why nothing the brain
  calls can start a fourth round", that the owner's answer is the only writer that lowers the count; the merge is the
  second, and nothing the brain calls reaches it (`merge_ticket` merges only what the rules would, with a skip recorded).
- **Why:** The recommended option: a merge is progress, and the cap is for work that keeps failing, not for a long chain.
- **Other options:** One count for the whole chain; a count per issue.

## 2026-11-17 — What the brain is told about a chain of several pull requests

- **Chosen:** Nothing between pieces. When the chain is merged, one `[hub]` message lists the pull requests merged in
  order with the issues each closed and its commit, the rule of the last, the final merge commit (which contains every
  earlier one), and whether the repository has a deployment, so the brain deploys once. When the chain stops at the
  cap, the existing message adds the same progress and what remains (open issues, open pull request). When the owner
  gives it up, the existing message adds it too. When the owner stops a ticket with 停止 and something of it is merged,
  the brain is told once (你停止了工单 n，已合并的部分保留) with the progress and whether the merged part needs deploying;
  `stop_ticket`'s answer carries the same lines. `read_ticket` lists each issue as merged or not and every pull request
  with its state; `list_tickets` marks merged issues and the pull requests on each line. `after` and `after_deployment`
  keep their meaning, with "merged" meaning every issue closed.
- **Why:** The owner wants the brain out of the hand-over, and a deployment once per chain. A stopped chain can leave
  merged work on the default branch that needs deploying, which the brain would not otherwise learn of.
- **Other options:** Telling the brain at every merge; telling it of every stop, including those with nothing merged.

## 2026-11-17 — What the page shows of a chain's pull requests

- **Chosen:** The ticket's panel lists the issues in order with a check on those closed by a merged pull request, and
  under PR every pull request in the order handed in, with its state (已合并, 未合并, 已关闭) as a dot of a fixed hue, its
  number linked to GitHub, and the issues it closes. The 代码 section no longer repeats the pull request; the summary
  still shows the latest. Rows in 工作台 and 历史 show the issue numbers with a check on the merged ones, and the pull
  request numbers with the PR icon, merged ones in the success colour. The timeline shows the move back to work with its
  reason (PR #n 已合并，接着做 …) and each piece as the next attempt.
- **Why:** The owner's rule: the layout explains itself, with no labels added; a check and a state dot say it.
- **Other options:** A progress count such as 2/3; a separate section per pull request in the timeline.

## 2026-11-17 — A chain in the development harness, and what was verified

- **Chosen:** The scripted worker of `tools/page-dev` hands in, for each piece, a pull request closing the first half
  (rounded up) of the chain's open issues, numbered `100 + ticket × 10 + piece`; `/__harness/loop?case=chain` starts a
  chain of three issues whose first pull request is red once. Verified: the hub's tests (`chain-pieces-api.test.ts`)
  drive a chain of three issues through a red pipeline, a guided round, a merge of the first pull request closing two
  issues, the continuation in the same session on a new branch with the count at zero and no message to the brain, and
  the second pull request to merged with one report; a merged pull request closing nothing; and the owner's stop with
  one pull request merged and one open. The runner's tests switch a real worktree to the next branch from an updated
  `main`, keeping an ignored file and the session, and correct a hand-in that closes no open issue. In the harness with
  `--forge fake`, the chain went working, verifying, back to working on red, merged #111 closing two issues, continued
  as attempt 3 with the reason PR #111 已合并，接着做 #6852, merged #112 and ended merged; the panel, 工作台 (mid-chain)
  and 历史 showed the checks and the pull requests. Not verified: a real worker cutting a chain into pull requests, and
  the GraphQL closing references against the real GitHub; the runner's `gh pr view` read of them was already live.
- **Why:** The issue asks to see a chain of several issues go through two pull requests on the page.
- **Other options:** A second scripted behaviour per chain size.

## 2026-11-17 — Uncommitted work when the folder moves to the next piece

- **Chosen:** Before the runner moves the worktree to the next piece's branch, it checks `git status` (untracked files
  included, ignored ones not). Anything there is committed, without hooks, on a local branch named after the old branch
  with `-unfinished` at the end; the worktree then switches to the new branch from the updated default branch, and the
  runner tries to carry that commit over with `git cherry-pick --no-commit`, leaving the changes uncommitted on the new
  branch. When it applies cleanly the changes are there and a copy stays on the `-unfinished` branch; when it does not,
  the new branch starts clean and the work stays on that branch. The worker's continuation message says which, with the
  branch and the commit, and the `prepared` line on the page says it too. If the switch itself fails, the attempt fails
  (`prepare`) instead of the folder being made again, so nothing is thrown away. A run of the same step after a restart
  finds the folder on the `-unfinished` branch and carries on from there. The `-unfinished` branch stays local and is
  not pushed. `WORKER.md` advises committing or dropping everything before handing in. This replaces, in "Branches for
  the pieces of a chain, and which pull request is the ticket's", switching with `--discard-changes`, which threw such
  work away.
- **Why:** A worker may start on the next issue before handing in, and nothing should disappear silently. A named
  branch survives restarts and is not shared the way the stash list is between every worktree of one clone; carrying
  the work over when it applies cleanly lets the worker continue as if nothing had happened.
- **Other options:** A named stash; always carrying over and leaving conflict markers; refusing to switch until the
  worker cleans up, which would block the chain.

## 2026-11-17 — Attachments are uploaded in parts the page sends, straight to disk

- **Chosen:** The page creates an attachment with `POST /api/attachments` (name, size, media type) as soon as the owner
  picks, pastes or drops a file, then sends it in parts of 8 MiB with `PUT /api/attachments/<id>/upload?offset=<n>`
  (`application/octet-stream`); the hub streams each part to the end of the file on disk and answers how much it has.
  A part at the wrong offset is refused with what the hub has, `GET /api/attachments/<id>/upload` says the same, and a
  part that would pass the declared size is refused and cut back. A part that fails leaves the chip red; tapping it, or
  pressing 发送, sends the rest from where the hub stopped. The message carries only the attachment ids, and the hub
  refuses a message whose attachments are not complete. Uploads need the owner's session and the page's own origin,
  like every other change. There is no cap on count or size; the only physical bound is the 64 MiB request guard,
  which a part never reaches. An attachment's row (id, name, size, type) is in a new table (migration 22), its bytes
  only on disk.
- **Why:** Cloudflare refuses a request past its own body limit, and a phone on a mobile network drops connections; parts
  the page can resume are the only way a video of a few hundred megabytes arrives. Uploading before 发送 makes sending
  instant for small files and lets the composer show progress.
- **Other options:** One multipart request per message (no resume, and the whole message fails with one file);
  uploading at 发送 only; a resumable-upload protocol such as tus, which needs a library on both sides for the same
  result.

## 2026-11-17 — Attachments live on the brain-link volume, in a folder per attachment

- **Chosen:** The hub keeps attachments under `HUB_ATTACHMENTS_DIR` (default `<HUB_DATA_DIR>/attachments`); the compose
  file sets it to `/var/lib/superagent2/link/attachments` on the `superagent2-brain-link` volume, which the brain's
  container mounts read-only at the same place and knows as `BRAIN_ATTACHMENTS_DIR` (default that path). Each file is
  `<id>/<stored name>`: the id is 32 random hexadecimal characters; the stored name is the owner's name with path
  separators, characters Windows refuses and control characters replaced by `_`, leading and trailing dots and spaces
  removed, a Windows device name prefixed with `_`, and anything past 180 bytes cut with the extension kept. The owner's
  own name is kept only in the database and shown on the page. The hub sends the brain the path relative to the folder,
  and the brain refuses one that is absolute or climbs out of it. A worker's attachments use the same store.
- **Why:** That volume is the only place both containers see, and putting the store there costs no copy of a large file.
  A folder per id means two files of the same name never meet and the name the program sees is still the owner's.
- **Other options:** Keeping attachments in `hub-data` and copying each one into the link volume when the brain needs it;
  a new volume shared by both containers (one more volume to create on the NAS for the same effect); serving the file
  to the brain over HTTP, which its programs cannot read as a path.

## 2026-11-17 — Each program gets an attachment in the best way it has, and always its path

- **Chosen:** The message to the program, from the brain or a runner, ends with a `[hub]` list of every attached file:
  its name, type, size, attachment id (for the brain) and absolute path. PNG, JPEG, GIF and WebP files are also given as
  images: to Claude Code as base64 image blocks in the stream-json user message, to Codex as `localImage` input items
  by path, to dsh as `SdkEncodedImageBlock`s in `session/prompt`. This holds for the first message of a turn and for a
  message taken into a running turn: Claude Code and Codex take the same items in a steer, and dsh's steer goes through
  our control plugin, which saves the images in dsh's own attachment store (`ctx.get("attachments").saveImages`) and
  adds the references to the steered message. Any other type (HEIC, PDF, a spreadsheet) is never sent as an image; the
  program reads it at its path with its own tools. A size bound is applied only where a program has one: dsh refuses a
  source image over 20 MiB and refuses the whole message when one image is refused, so larger images are left to the
  path, and if dsh still refuses a prompt with images, it is sent again with the text alone; the plugin does the same
  for a steer. Claude Code accepted a 15.7 MB, 3000 by 2200 PNG and Codex the same file, both resizing it themselves;
  images over 20 MiB go to Claude Code by path only. Antigravity gets the path.
- **Why:** Checked against each program's own interface and in live runs: a solid-colour image and a text file with a
  random code word, as the first message and as a message into a running turn. Claude Code and Codex answered the colour
  from the image itself and read the code word at its path. The path is what lets any program open a file it cannot
  see. What this entry first said about dsh, that its route is text only and the model found the colour by reading
  pixel values, was wrong; see "dsh sees images on deepseek-flash" below.
- **Other options:** Paths only, which loses Claude's and GPT's sight of the image; images only, which loses every other
  file; converting HEIC to JPEG on the hub, which needs an image library and is unnecessary because Safari already
  converts a photo picked from the library to JPEG.

## 2026-11-17 — A file for a worker lands outside its worktree, and a message waits for an absent machine

- **Chosen:** `work.message` carries the attachments (id, name, size, type). The runner asks the hub for each in parts of
  8 MiB (`work.attachment`, answered by `work.attachment.part`), appends them to
  `<runner home>/work/t<ticket>/attachments/<id>/<stored name>`, beside the ticket's worktree and never inside it,
  resumes from what it already has, and gives the message to the program only when every file is there. The hub
  answers only for a file given to that ticket (by a message or as material) and only to the machine of that attempt.
  Messages to a worker are now kept by the hub in a new table until the runner's `message` event for them arrives. One
  sent while the machine is away, or while the ticket is between two attempts (verifying a piece of a chain, waiting for
  a guided round, or with its next attempt queued), is accepted and given to the ticket's current attempt whenever one
  starts and at every `hello`; a message is refused only when the ticket is neither working nor verifying. The runner remembers the ids it has handled (from its event log too), so a message given twice is taken once,
  and delivers a ticket's messages one at a time in order. If the link drops while a file is on its way, the runner
  forgets the message and takes it again from where the file stopped when the hub gives it again. Files already fetched stay in the ticket's folder
  when it moves to the next branch of a chain. The brain's `message_worker` tool takes attachment ids, and says when the
  message is kept rather than delivered. A message that is still waiting when the ticket ends is not delivered.
- **Why:** The worktree is committed by the worker; a file inside it would be committed by accident. Keeping the
  message on the hub is the only way a message to a machine that is asleep or rebooting is not lost, which was the case
  for text messages too (they were refused); with attachments the owner would otherwise have to upload again.
- **Other options:** The runner downloading over HTTP (a second credential path through the front door); the hub
  pushing parts unasked (no back-pressure); keeping the old refusal when the machine is away.

## 2026-11-17 — The brain hands an attachment to a writing worker by its id

- **Chosen:** A piece of `material` in `open_writing_ticket` may name an `attachment` id instead of `text`. The hub checks
  that the attachment exists and is complete, stores it with the material (name, size, type), and allows that ticket's
  machine to fetch it. The runner fetches it before the worker starts and copies it into the scratch folder's `input/`
  under the material's name; the brief lists it as `input/<name>`. `read_ticket` names the attached file. The brain's
  guidance says to pass an attached file this way and never as a summary.
- **Why:** The brain is the only way material reaches a writing worker, and a photo of a letter or a PDF contract cannot
  pass as text. Reusing the worker's fetch keeps one path for files to runners.
- **Other options:** The brain copying the file to the machine with `run_command`, which works for a file it can read but
  needs it to know where the worker's folder will be; giving the worker the hub's URL, which needs a credential.

## 2026-11-17 — Attachments are shown, downloaded and kept

- **Chosen:** In the composer each file is a chip with a small picture for an image, a thin progress line while it
  uploads, and a cross to remove it; there are no words beside them. A sent message shows images as pictures up to 240
  pixels and other files as chips with name and size; each is a link to `GET /api/attachments/<id>` with the `download`
  attribute. The hub serves it as an attachment with `nosniff` and `sandbox`, with the declared type only for PNG, JPEG,
  GIF and WebP and `application/octet-stream` for anything else, and lets the browser cache it, since an attachment never
  changes. The attach button is a plain file input with no `accept` filter, which on an iPhone offers the photo library,
  the camera and Files. A pasted image without a name is named by the time it was attached. Attachments are never
  deleted, and nothing caps them.
- **Why:** The owner's interface rule and the prototype, which already drew attachment chips in the composer and under a
  message. A file input without a filter is the one way Safari offers all three sources at once.
- **Other options:** A retention rule (for example removing attachments that no message refers to after a month), which
  is proposed in the pull request for the owner to decide; showing every image type inline, which would let an SVG run.

## 2026-11-17 — Telling the brain when a pipeline runs far beyond the usual

- **Chosen:** While a ticket is verifying and the pipeline for its head has not finished, or has not appeared, the hub
  compares how long it has waited with what is usual for the repository. When the wait reaches three times the usual,
  the hub sends the brain one `[hub]` message for that pipeline, and again each time the wait doubles again (3, 6, 12,
  24 times the usual, and so on), never at every poll; a hub that was down and finds the wait at 40 times the usual
  sends one message for the highest step, not one for each missed step. The count is kept per ticket, entry, head and
  pipeline number, in the ticket's verification row (`notice_key`, `notice_count`), so a restart of the hub does not
  repeat a message, and a pipeline restarted in Woodpecker (a new number for the same commit) is a new pipeline that is
  told about afresh. The wait is measured from the pipeline's own `created` time in Woodpecker, the same start the
  usual is measured from, so waiting for an agent counts; for a head with no pipeline at all it is measured from when
  the hub first saw that head (`head_at`), and the same rule and threshold apply. The message gives the ticket, the pull
  request, the head, the pipeline's link, how long it has waited, what is usual and how that was found, what
  Woodpecker says right now (the pipeline's status and age, and each workflow pending, running or done, with its agent
  where there is one), and when the next message comes. It says plainly that nothing is decided from the time. The
  owner's conversation gets a Chinese notice with the wait and the usual, so the owner can see that the brain was told
  and is looking. A notice changes no state: the ticket stays verifying, no check fails, no round is counted, nothing
  is cancelled or restarted. The factor is 3 because pipelines vary by a factor of two or less for ordinary reasons
  (queueing behind another run, a cold cache, a slower agent), and 3 is beyond that while still early: a 14-minute
  usual is looked at after 42 minutes, not after a day. Doubling follows the owner's own words: growing intervals, so
  a pipeline that stays stuck for a day costs the brain about six messages, not one at every one of the 2,880 checks. This refines "When the hub
  checks, and what it never does", which listed "a time limit after which the brain is told" as an option not taken:
  there is still no limit after which anything is decided or failed, and still nothing is decided from time; the time
  only decides when the brain is asked to look, and the look decides, as "What a failure is, and what counts as a
  guided round" still says: a pipeline that never reports is not a failure, and is not counted as one.
- **Why:** The owner's decision: far beyond the baseline the brain should look at what the problem is without
  interrupting anyone, and step in only when the look finds one. The system's first priority is unattended automation,
  so a pipeline that never reports (an agent that is off, a step that hangs, a stuck queue, a webhook that never
  arrived) must not leave a ticket verifying for days with nobody told, and no cap or fixed limit may turn a slow
  pipeline into a failure.
- **Other options:** A fixed limit, which would fail slow pipelines and miss fast repositories; telling at every poll or
  at fixed intervals; a limit after which the hub cancels or restarts the pipeline itself; a floor under the threshold
  for repositories whose pipelines take seconds (not done, so that no fixed time is hidden in the rule; a repository
  that fast would simply be looked at sooner, and the look is cheap); also covering a pipeline that finished not green
  (`killed`, `blocked`, `declined`), which has ended rather than run long and stays out of this change; also covering a
  hub that cannot read Woodpecker at all, which the ticket already shows as waiting for Woodpecker.

## 2026-11-17 — What is usual for a repository

- **Chosen:** The hub records, for each repository, every pipeline it saw end green: its Woodpecker number and Woodpecker's
  own `created` and `finished` times, so the length runs from creation to finish and includes the wait for an agent
  (table `pipeline_durations`, one row per repository and pipeline, never trimmed). A pipeline is recorded when the hub
  judges it green for a ticket, and also when a green pipeline shows up in the list of a pull request's pipelines that
  the hub already reads to find the head's pipeline, so a repository's earlier pull requests give it history at once.
  Pipelines of pushes to the default branch are not listed by that call and are not recorded. The usual is the median
  of the 15 most recent green lengths, by finish time, and exists only from 3 runs. The median because one odd run, a
  wedged agent that finally finished or a lucky cache hit, does not move it, where a mean would; 15 so that up to seven
  odd runs still leave the middle honest, and recent so that it follows a pipeline that grows or shrinks over time; 3
  because the median of one or two runs is those runs.
- **Why:** The owner asked for the baseline to come from how long the repository's pipelines took when they ended green,
  derived so that one odd run does not distort it, with no cap on what is kept. Woodpecker's own timestamps are used so
  that the number does not depend on when the hub happened to poll.
- **Other options:** The mean (moved by one odd run); a percentile such as the 90th (needs more history to mean
  anything); measuring from the first poll that saw the pipeline; keeping only a fixed number of rows.

## 2026-11-17 — A repository with no history yet

- **Chosen:** Until a repository has three recorded green runs the hub uses a first-time allowance in place of three
  times the usual: the brain is told when the wait reaches it, and again at each doubling. The allowance is a setting,
  `HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES` in the hub's environment, with a default of 120 minutes. It is used only until
  there is history, and the message says so. The default is generous because Woodpecker's own limit for one run is 60
  minutes by default and a first run may queue behind others, so a first pipeline that is merely slow is not looked at.
- **Why:** A repository whose first pipelines are still running has nothing to compare with, and a notice at every
  first pipeline would be noise, while no notice at all would leave exactly the case the owner is worried about,
  a new repository with an agent that is off, unnoticed.
- **Other options:** No notice until there is history; a value kept in the page's settings, which no one is likely to
  change; reading the allowance from a default that is tied to a repository's size; using the larger of the allowance
  and three times a median of one or two runs.

## 2026-11-17 — What Woodpecker says about an agent, and what the brain looks at

- **Chosen:** The hub reads, in the pipeline it already fetches, each workflow's `state`, `agent_id` (0 when no agent
  has taken it), `started` and `finished`, and the pipeline's `created`, `started` and `finished`. For a pending
  workflow the message says whether an agent has picked it up: `agent_id` is set when an agent takes the work, so a
  pending workflow without one is waiting for an agent, and one with one has been handed out and not yet started. The
  hub does not call Woodpecker's agent list or its queue, which need an administrator's token and answer about the
  whole server rather than one pipeline; the brain does that, with `run_command` on the hub's container, where
  `WOODPECKER_SERVER` and `WOODPECKER_TOKEN` already are, and the owner's token has administrator rights. This was
  written from Woodpecker's documented API and the shapes the hub already parses; it was not run against the real
  server, so the guidance tells the brain to read the shapes before relying on them. What the hub cannot tell from the
  pipeline alone: whether any agent is online, and how many workflows are queued ahead.
- **Why:** The message should carry what is cheap and certain and leave the rest to the look, which is the brain's job
  and needs a conversation's judgement.
- **Other options:** The hub reading the agent list for every message; leaving out the agent and the workflow detail
  and saying only how long it has waited.

## 2026-11-17 — Where the wait shows

- **Chosen:** `read_ticket` shows, while a ticket waits for a pipeline, how long it has waited, what is usual for the
  repository and how that was found (or that there is none yet), when the brain is told, and that the time decides
  nothing. The page is unchanged: its verification line already says what the ticket waits for, and a running count in
  it would be a second label for something the owner reads in the conversation's notice.
- **Why:** The owner's rule is no unnecessary secondary labels. The notice in the conversation is where the owner sees it.
- **Other options:** Appending the wait and the usual to the verification line on the page.

## 2026-11-17 — dsh sees images on deepseek-flash

- **Chosen:** No change to how the dsh adapter passes images: `SdkEncodedImageBlock`s in `session/prompt`, and images
  saved through dsh's attachment store for a message into a running turn, reach `deepseek-flash` as images. The
  `[hub]` list under a message now says that an image of up to 20 MB is shown with the message and is to be looked at
  directly, without a tool, and only other files are read at their paths; the brain's guidance says the same. The live
  step in `tools/brain-live` now draws a random shape in a random colour and fails when the answer misses either, or
  when any tool call names the image's attachment (that is, a tool opened the file instead of the model looking). This
  overturns the earlier finding in "Each program gets an attachment in the best way it has, and always its path" that
  dsh's route is text only.
- **Why:** The owner said dsh's model is multimodal. Checked with the real dsh 0.2.1-rc.2 and the owner's account,
  through dsh itself: the account's `GET /models` listing, read with dsh's own `llm.listModels("deepseek-account")`,
  offers two models, `deepseek-flash` ("DeepSeek-V4.1-Flash", input text and image) and `deepseek-v4-pro`
  ("DeepSeek-V4-Pro", input text only). A prompt with a 128-pixel shape and "do not use any tool" was answered
  correctly three times in a row (green triangle, blue triangle, green triangle) with no tool call, and the strict live
  step passed for the first message and for a message taken into a running turn. The image had reached the model in
  the earlier run too. The model had been told to "read any attached file with your own tools", so it opened the image
  with `read_image` (whose text result is only a description of the file) and then sampled pixels with PowerShell. I
  read that as a sign the route could not see the image without testing that directly. The start defaults already use
  `deepseek-flash` for dsh everywhere, so no model id changes; a dsh set to `deepseek-v4-pro` gets dsh's placeholder
  instead of the image and still has the path.
- **Other options:** A `modelOverrides` entry declaring image input, which is unnecessary because the listing already
  declares it; moving dsh to another model id, which the account does not offer for images.

## 2026-11-17 — Two kinds of ticket: code and task

- **Chosen:** At the owner's review, a ticket is one of two forms, `Ticket.form`: `code` (a chain of GitHub issues of one
  repository, unchanged) or `task` (everything else). A task ticket is a task in words with material and attachments,
  optionally a repository, a commit and `deploys`; a worker does it on a machine and hands back an outcome, a report and
  any text and files, and nothing is verified. The writing ticket is a task ticket and not a third shape: the brain opens
  it with `open_task_ticket` (which replaces `open_writing_ticket`), `kind` `writing`. The attributes stay inputs to the
  start defaults only: kinds are `writing` and `operation` for a task ticket (prose goes to Antigravity by default, an
  operation to a code engine by difficulty, with the engine the brain states) and the five code kinds for a code ticket;
  the hub refuses a kind of the other form. `canMoveTicket` reads the form, so a task ticket never verifies or merges and
  a code ticket is never delivered. Antigravity still never runs a code ticket, on the card, in 改派 or at the start. A
  wait is met when the ticket before it has merged (code) or is done (`delivered`, task). Renamed: `WritingTask` to
  `TaskAssignment`, `work.write` to `work.task`, `WritingMaterial` to `TaskMaterial`, `WritingHandback` to `TaskHandback`,
  the table `ticket_writing` to `ticket_tasks`, `guidance/WRITER.md` to `guidance/TASK.md` (one guidance for every task
  ticket, prose advice a part of it), `writing.ts` to `task.ts` in the runner. Migration 24 adds `tickets.form` (`task`
  for every ticket of kind `writing`, `code` otherwise), `tickets.required_machine`, and `commit_ref`, `commit_sha` and
  `deploys` to `ticket_tasks`, so every writing ticket in the live database is a task ticket with its task and material
  as they were. This overturns the writing parts of "The ticket and its states", "A writing ticket's task and material",
  "The scratch folder and the hand-back of a writing worker", "Delivering the text and files into the conversation",
  "Which engine may run which ticket", "Where the brain is told to open writing tickets, and what was verified" and "The
  brain hands an attachment to a writing worker by its id" where they name a writing ticket as a kind of its own; what
  they say of material, attachments, the scratch folder and delivery still holds for task tickets.
- **Why:** The owner's words: apart from code tickets, which need pull requests, the others have no such restriction.
  A separate field keeps the form from depending on an attribute the brain states and may restate.
- **Other options:** Deriving the form from the kind (`writing` and `operation`), which ties the shape to an attribute;
  a third form for deployments; keeping `open_writing_ticket` beside a new tool.

## 2026-11-17 — What a task worker hands back, and what a failed outcome is

- **Chosen:** `{"outcome": "done" | "failed", "report": {"en", "zh"}, "text"?: <file>, "files"?: [...]}` at the
  hand-back path; `outcome` defaults to `done`, and a hand-back that still says `summary` is read as the report, so a
  worker briefed by the previous version is not refused. A report alone is a valid hand-back. The runner sends it as the
  `delivered` event with the new optional fields `outcome` and `commit` (the checkout's commit), so a hub and a runner
  one version apart still read each other's events. Done: as before, the files are fetched, the ticket becomes
  `delivered` (shown as 已完成), and the result goes into the conversation, now with the worker's Chinese report, which
  the page shows when there is no text. Failed: the attempt fails with the new failure `task-failed` and the report as
  its reason, the report is kept on the ticket, files are not fetched, and the failure loop takes it like any failed
  work: the brain guides, it counts toward `roundCap` (it is not a failure of the machine), and at the cap the ticket
  stops for the owner.
- **Why:** The brief: a failed deployment is a failed task ticket through the existing loop. Optional fields rather
  than a new event kind keep a mixed-version hub and runner from closing their link on each other.
- **Other options:** A new `outcome` event; delivering a failed result into the conversation as well; fetching the files
  of a failed outcome.

## 2026-11-17 — What the runner prepares for a task ticket with a repository

- **Chosen:** Always the scratch folder `work/t<n>/scratch` with `input/` and `output/`. When the ticket names a
  repository, also a checkout of it, detached at the commit, at `worktrees/<name>-t<n>` from the shared clone (`git
  worktree add --detach`, under the same per-clone lock as code worktrees), and the program works in the checkout, so the
  repository's own instructions are read; the brief names both folders and the machine's name. The worker gets the
  owning account's token, as a code worker does; a task without a repository gets none. The commit is: a SHA or a branch
  the brain named (a branch is resolved by the runner when it checks out, so it means its head when the work begins),
  the default branch's head when none was named, or `merged`, the final merge commit of the code chain of that
  repository the ticket waits for, which the hub fills in from its own record when the ticket begins (the latest-merged
  such chain when there are several, since its merge commit contains the others). The runner reports the commit it
  checked out with the hand-back, and the hub keeps it on the ticket. A new attempt keeps the checkout when it is at the
  same commit. Stopping removes the checkout and the scratch folder.
- **Why:** The suggested option. Filling `merged` from the hub's record needs no GitHub call at begin, so a begin cannot
  fail on GitHub; a branch resolved by the runner is the head at the moment the work starts.
- **Other options:** Resolving every commit through GitHub at begin; the checkout inside the scratch folder; the program
  in the scratch folder with the checkout beside it.

## 2026-11-17 — A deployment is a task ticket, done by a worker

- **Chosen:** At the owner's review, the brain no longer deploys. `deploy_repository`, `read_deployment`, the hub's
  deployment service with its health loop, rollback and outcome-line parsing, and the tables `deployments` and
  `deployment_steps` are removed (migration 24 drops the tables; the commands they ran stay in the command history). A
  deployment is `open_task_ticket` with `deploy: true`, `kind` `operation` and the repository, usually `after` the chain
  it deploys, at filing time, so the owner's one 开始 starts both and the deployment begins by itself when the chain has
  merged, at `merged`. `.superagent2/deployment.json` stays as the worker's recipe with the same keys; `target` now names
  the work machine the ticket must run on (a runner's name; `hub` and `nas` are refused, since no worker runs in the
  hub's container or on the NAS host). The hub reads the file on the default branch when the ticket is opened: a valid
  file pins the ticket to that machine (`requiredMachine`, the card's only machine; the owner choosing another is refused
  with 422 rather than silently replaced), an invalid one refuses the ticket, and a missing or unreadable one opens it
  with no pin and a note. The runner reads the file at the checked-out commit and fails the attempt as `prepare`,
  before any program starts, when it is missing, invalid or names another machine. When a deploying task ticket is
  done, the hub marks deployed itself, the merged code tickets it waited for, and every other merged ticket of the
  repository whose final merge commit the deployed commit contains (GitHub's compare, as before); one it could not check
  is left unmarked and the brain is told. `after_deployment` keeps its meaning (merged and marked deployed), and a chain
  may also come after the deployment's ticket by number. `report_deployment` stays, for work deployed by other means
  (the owner by hand). The merge report now says which task ticket deploys the chain, or that none is arranged and how to
  open one. This overturns "A ticket never deploys" in the design, "What the deployment file holds" (the `hub` and `nas`
  targets), "The previous version, and a first deployment", "How a deployment runs, and what ends it", "A restart of the
  hub during a deployment", "What a successful deployment marks deployed" (now done when the task ticket is done), "Where
  the owner sees deployments", "Deployments in the development harness, and what was verified", "Super-agent2's
  deployment file, and why its shape did not change" and the deployment parts of "The brain's reach ends at the hub's
  container" (`deploy_repository` refusing the hub's repository, the outcome line).
- **Why:** The owner's words: deploying is the same as telling Codex or Claude Code to deploy the project, and a ticket
  needs the owner's release anyway. Pinning at opening is what helps the brain arrange; the runner's check is what holds
  when the file changed in the chain.
- **Other options:** The brain opening the deployment after the merge (a second start); a `target` meaning a platform;
  refusing a deployment whose file is not on the default branch yet.

## 2026-11-17 — A pinned machine must be online at the start

- **Chosen:** A deployment's machine is resolved as any machine is: the start of the chain it follows is refused as
  incomplete while that machine is offline, as for any ticket whose machine is away, and a begun ticket waits in the
  queue for it.
- **Why:** The rule every ticket already follows; showing the machine as missing is the truthful card.
- **Other options:** Accepting an offline pinned machine at the start from its last report.

## 2026-11-17 — The brain's commands run only in the hub's container

- **Chosen:** At the owner's review, `run_command` has one target, `hub`; `target` is optional and anything else is
  refused with the reason. Runners are no longer targets of the command service, and the runner no longer runs commands
  at all: `run`, `stop`, `output`, `ended` and `failed` are gone from the runner protocol, with the runner's shell
  runner. A runner ignores a message type it does not know (and logs it once) instead of dropping its link, so a newer
  hub cannot make an older runner reconnect in a loop. The command environment, which only deployments set, is removed
  with its part of the hold fingerprint (a command without environment keeps the fingerprint it always had) and the hold
  card's environment block; migration 24 withdraws any deployment command still held and drops `commands.environment`.
  This overturns runner targets in "Targets, shells and stopping", "Commands on a runner, and when the connection is
  lost", the runner targets kept by "The brain's reach ends at the hub's container", "What the commands of a deployment
  receive" and "A held command's environment is part of what the owner confirms".
- **Why:** The owner's words: the brain itself must not reach the NAS, and its own rights are kept small because it will
  get automation that needs no nod. A runner that can run nothing but workers is the strongest form of that.
- **Other options:** Keeping the runner's command channel unused; keeping runner targets behind the confirmation lock.

## 2026-11-17 — Super-agent2 deploys itself through a ticket

- **Chosen:** `.superagent2/deployment.json` is restored as a recipe: `target` `pc` (the owner's Windows PC, whose SSH
  alias `novan-nas-maintenance` reaches the NAS), `deploy` `ssh novan-nas-maintenance "bash
  /share/Container/superagent2/deploy.sh release $(git rev-parse HEAD)"` run in the checkout, `health` `deploy.sh
  health`, `rollback` `deploy.sh rollback`, health every 10 seconds for up to 10 minutes. `deploy.sh` is unchanged: the
  release runs in the foreground of the worker's SSH session and goes back by itself on failure. The machine's name is
  an assumption: the owner names the PC's runner `pc`, or changes the file through a code ticket.
- **Why:** The worker uses its own machine's access, as the owner would; nothing of the hub's reaches the NAS. `$(...)`
  works in both Bash and PowerShell, the shells the workers use.
- **Other options:** A Mac mini as the target; a recipe in words instead of commands.

## 2026-11-17 — What broke when the hub was replaced under a running task ticket

- **Chosen:** Two things, both fixed and covered by `packages/runner/src/end-to-end.test.ts`, which runs a real hub and a
  real runner, starts a task ticket, closes the hub and starts a new hub at another version on the same database and
  port. (1) The runner's updater prepared the version a new hub announced and switched to it once its worker ended even
  when the hub had meanwhile gone back to the runner's own version (a release that rolled back); it now switches only to
  the version the hub announces at that moment, and says when it does not. (2) A runner dropped its link on any message
  it could not parse, so a newer hub sending a new message type made it reconnect in a loop; it now ignores unknown
  types. Verified as sound, with nothing to change: the link drops and comes back, the worker keeps running, its events
  are kept on disk and synced to the new hub, the hand-back is delivered there and the ticket ends done, and the runner
  then switches to the new hub's version.
- **Why:** The brief asked to make the self-deployment sound and to find what breaks.
- **Other options:** Holding the switch until the hub acknowledges the hand-back, which would hold updates while any
  ticket stays failed or stuck.

## 2026-11-17 — Task tickets on the page

- **Chosen:** 工作台 groups open tickets by repository, a task ticket with a repository in its repository's group (so a
  deployment follows the chain it deploys), and task tickets without one last under 任务. A deploying task ticket's kind
  chip says 部署; an operation 操作. 已交付 is now 已完成 for a done task ticket. The ticket's panel shows a task
  ticket's commit, linked to GitHub, where a code ticket shows its branch. A failed hand-back shows in the timeline as
  工作者报告任务没有完成 with the report. In 对话 a delivery shows its text as before, or the worker's report when there is
  no text, which is how a deployment reads there. No new labels.
- **Why:** The owner's interface rule: the layout explains itself.
- **Other options:** A separate group for deployments; showing the report under every delivery.

## 2026-11-17 — A chain and its deployment in the development harness, and what was verified

- **Chosen:** With `--forge fake`, `/__harness/deploy?repository=` puts a deployment file naming `studio` on the fake
  default branch, opens a one-issue chain and, through the brain's tools, a deploying task ticket after it, and states
  both defaults; nothing is started. The scripted worker deploys a `work.task` with `deploys` and delivers a report. The
  demo brain no longer deploys. Verified in the page: the 之后 card of the deployment showed 部署 and only `studio`; one
  开始 on the chain's card started both; the chain merged green, the deployment began at the merge commit, delivered, and
  marked the chain deployed; 对话 showed the merge notice 工单 1 已合并，接着部署 and the deployment's report; the ticket
  page showed the commit and the run; 历史 listed both. Hub tests cover filing, the pin and its refusal, the start, the
  begin at `merged`, done and failed outcomes, the marking, `after_deployment`, `run_command`'s refusal and the
  migration; runner tests cover the checkout, the hand-back, the machine check and the hub restart. Not verified: a real
  worker, a real deployment, and the NAS.
- **Why:** The brief asked to keep the harness able to show a chain followed by its deployment.
- **Other options:** Starting the pair from the harness.

## 2026-11-18 — Decisions made on the owner's behalf are recorded in the hub, per ticket

- **Chosen:** At the owner's request, the hub keeps a record of decisions per ticket in a new table, `ticket_decisions`
  (migration 25): what was chosen, why, and what other options there were, each as `GeneratedText` (English and
  Chinese), with the source (`worker` or `brain`), the attempt and pull request a worker's decision came with, when it
  was recorded, and the owner's review (`verdict` `ok` or `opinion`, the opinion's text, when it was reviewed, and when
  it was sent to the brain). `Ticket.decisions` carries them, in the order recorded, so the page, `read_ticket` and every
  report read one source. A decision whose three English texts equal one already on the ticket is kept once, so a worker
  that hands the same decision in again after a guided round, or the brain calling twice, adds nothing. When an
  arrangement joins a ticket into a chain, its decisions move to the chain's ticket. Nothing caps their number or length.
- **Why:** The owner's words: what matters is the record, and the brain must report, when a string of tasks ends, which
  decisions were made on the owner's behalf. Keeping it in the hub rather than in the brain's conversation means a new
  session or another provider loses nothing, and the report does not rest on anyone remembering.
- **Other options:** One free-text field per decision; keeping decisions in the brain's memory or in the issue's
  comments; a decision per issue rather than per ticket, which a decision about how work was arranged does not fit;
  refusing a repeated decision instead of keeping one copy.

## 2026-11-18 — A worker hands its decisions in with each pull request and with a task's hand-back

- **Chosen:** The hand-in file of a code worker and the hand-back file of a task worker take an optional `decisions`
  list, each with `chosen`, `why` and `otherOptions`, every one with `en` and `zh`; a hand-in with none, or without the
  field, is valid. A decision that is not complete (a missing field, a Chinese copy without Chinese) makes the file
  wrong, and the worker is told what to fix, as for any wrong hand-in. The runner's `finished` and `delivered` events
  carry them as a new optional field, so a hub and a runner one version apart still read each other. The hub records a
  worker's decisions only from the ticket's current attempt, with that attempt and, for a code ticket, the pull request;
  a failed task hand-back's decisions are recorded too, since they were made.
- **Why:** The owner wants workers to decide instead of asking half-way, and to record what they decided; the hand-in is
  the one moment a worker already writes to the hub.
- **Other options:** A separate decisions file; a tool for the worker to call (a worker has no tools of the hub's);
  reading `## Decisions` out of the pull request body, which a task ticket does not have.

## 2026-11-18 — The brain records its decisions with record_decision

- **Chosen:** A new tool, `record_decision` (`ticket`, `chosen`, `why`, `other_options`), records a decision against any
  ticket in any state, as the brain's. Its answer repeats the decision, or says it was already recorded. The guidance
  names what is worth recording (assumptions at filing, how the work was arranged, cut or joined, what a guided round or
  a message told a worker when it changes what gets built, a deployment arranged or left out) and what is not (what the
  owner decided, routine steps, the start defaults, which the owner sees and changes on the card, and the workers' own
  decisions).
- **Why:** The owner's words: the brain can decide on the owner's behalf, and must record explicitly.
- **Other options:** Recording the brain's decisions as part of `file_issue`, `arrange_chains` and `guide_ticket`, which
  would miss decisions made in a message or at any other time; parsing them out of the issue body.

## 2026-11-18 — Every end report lists the ticket's decisions

- **Chosen:** When a ticket ends, the hub's message to the brain lists every decision recorded for it, in English with
  its source and review state, then the Chinese copies in the same order, and asks the brain to report every one to the
  owner in Chinese, briefly. That covers a merged chain, a task ticket done (in the delivery's prompt), a ticket stopped
  at the cap, one the owner gives up, one the owner stops with 停止, and the answer of `stop_ticket`. A ticket with none
  says so in one line. The owner's 停止 now tells the brain also when nothing is merged but decisions are recorded
  (你停止了工单 n), which changes, in "What the brain is told about a chain of several pull requests", that a stop with
  nothing merged is not told. `read_ticket` lists the decisions with the owner's review of each.
- **Why:** The owner asked that the report be guaranteed by code. The Chinese copies are the decision maker's own words,
  so the brain need not translate them again.
- **Other options:** One message for a whole arrangement of chains when its last ticket ends, which needs a notion of
  "a string of tasks" the hub does not have; leaving stuck tickets out because they can resume; English only.

## 2026-11-18 — The owner's review: 可以 or one opinion, and one message to the brain

- **Chosen:** On the ticket's page each unsettled decision has 可以 and one box for an opinion with a send button.
  可以 settles it as OK; a sent opinion settles it as not OK, as the owner wrote it. A settled decision is final: it shows
  muted, with a check for 可以 or the opinion under it. While the box has text, 可以 is disabled and the send button is
  the primary one; Enter sends on a keyboard. Each press is one request, `POST /api/tickets/<n>/decisions/<id>` with
  `{"verdict": "ok"}` or `{"verdict": "opinion", "opinion": "..."}`, in the owner's session and from the page's own
  origin like every change; a decision already settled answers 409. When the press settles the last unsettled decision
  of the ticket, the hub sends the brain one `[hub]` message with every opinion not yet sent and its decision, and lists
  the decisions accepted as they were, and the conversation shows 你看完了工单 n 的决定，k 条意见交给了大脑. A review with
  no opinion sends nothing. A decision recorded after a review starts a new batch, and only that batch is sent when it
  is settled. The message asks the brain to group the opinions into follow-up work as it sees fit and to talk with the
  owner first where the scope of a fix is unclear.
- **Why:** The owner's words: each item has 可以 and simply one opinion box, an opinion means it is not OK, there is no
  need for one issue per point, and the brain receives the whole review and decides the grouping. Settling as the owner
  goes, with no separate submit, is the smallest interaction; a partly reviewed ticket keeps what was pressed.
- **Other options:** A 提交 button after the last item (one more press); letting a settled decision be changed until the
  batch is sent; a message for every opinion; telling the brain also when everything is OK, which would make it answer
  with nothing to do.

## 2026-11-18 — Where decisions to review surface, and what a ticket with decisions looks like

- **Chosen:** The decisions are a section 决定 above the ticket's timeline, with the hot count of those not settled yet,
  in the prototype's list style (`mem-list`): what was chosen in bold, why below it, the other options muted after a
  swap icon, and the pull request a worker's decision came with as a link. Who decided is not shown. Finished tickets
  with decisions to review carry the count on their row in 历史, and 历史 in the sidebar and the tab bar carries the
  total, as 记忆 carries its suggestions; the hub sends the counts with the open tickets when the page connects
  (`TicketsUpdate.reviews`), and every change of a ticket updates them. Open tickets are not counted, and joined
  tickets, which 历史 does not list, neither. There is no push notification and nothing in 等你.
- **Why:** The suggested option: where finished tickets already surface, with a count, and no push. The owner's rule:
  no secondary labels; the layout says what is chosen, why and what else there was. The owner said it does not matter
  who decided.
- **Other options:** Pinning tickets to review at the top of 历史; a filter in 历史; counting open tickets too; labels
  such as 理由 and 其他选项; showing whether the worker or the brain decided.

## 2026-11-18 — Issues are plans in advising language, and workers decide instead of asking

- **Chosen:** "Turning a need into issues" in the brain's guidance is rewritten: when the goal or the scope is unclear,
  the brain talks with the owner before filing, one short question at a time; details of implementation are decided and
  recorded, not asked. An issue is a fairly complete plan: background, goal, a suggested approach, scope (in and out),
  open points each with a recommended option, and what done means, in advising language ("suggested", "recommended",
  "one reasonable way is"), with firm wording only for what the owner explicitly required, marked as such. The
  `## Assumptions` section of an issue gives way to open points and recorded decisions. `file_issue`'s description says
  the same. The worker guidance (`WORKER.md`, `TASK.md`) says from the other side that an issue's approach is a
  suggestion, that a better way may be taken and is recorded as a decision, that a worker decides rather than stops,
  and what is worth recording (the test: would the owner want to have been asked). The sections touched now advise
  ("usually", "prefer") except where they describe what the code enforces (the hand-in checks). This overturns, in the
  design's ticket flow and in the guidance described by "The brain's guidance" and "What a worker is told", the brain
  writing its assumptions into the issue as its way of not asking, and the worker's "make a reasonable assumption and
  say it in the pull request".
- **Why:** The owner's words: an issue should be a fairly complete plan, not one sentence describing a problem, and
  overly definite language makes later LLMs refuse to adapt; a worker should not ask half-way.
- **Other options:** A fixed issue template the hub checks; keeping `## Assumptions` beside the decisions.

## 2026-11-18 — Leftover conflict markers in the brain's guidance

- **Chosen:** `AGENTS.md` on `main` held the markers of an unresolved merge in its attachments paragraph. It now keeps
  the later text (images of up to 20 MB shown to every provider) with "task ticket" for the material.
- **Why:** The brain read both versions and the markers as its guidance.
- **Other options:** None worth keeping.

## 2026-11-18 — Decisions in the development harness, and what was verified

- **Chosen:** In `tools/page-dev`, the scripted worker hands in one decision with each piece of a chain (a different one
  per piece), one with a delivered writing task and one with a deployment; `/__harness/loop?case=chain` also records,
  through the brain's `record_decision`, how the chain was arranged. The demo brain reports a ticket's decisions in
  Chinese from the end report's Chinese copies, and answers a review message. Verified in the page at desktop and phone
  width with `--forge fake`: the chain merged with three decisions (one the brain's, two the worker's, the one repeated
  by the red-once attempt kept once); 历史 showed 3 on the row and in the navigation; 可以 on the first muted it with a
  check and lowered both counts; an opinion typed in the box turned the send button primary and disabled 可以; the last
  opinion, sent at phone width, settled the ticket and cleared the counts, and the conversation showed the brain's
  report of the three decisions, 你看完了工单 1 的决定，2 条意见交给了大脑, and the demo brain's answer; a delivered task
  ticket showed its decision above the timeline. Hub tests cover recording from both sources, the dedupe, the end
  reports (merged, done, the owner's stop with nothing merged, none recorded), the review endpoint (owner and origin
  checks, 400, 404, 409), one message per batch, no message for an all-OK review, the counts and the move on join;
  runner tests cover the hand-in and hand-back with decisions and the correction of an incomplete one; page tests cover
  the section, the history count and the navigation count. Not verified: a real worker writing decisions, and a real
  brain reporting them or grouping opinions into issues.
- **Why:** The brief asked to keep the harness able to show a finished chain with decisions from both sources, reviewed
  in the page, at desktop and phone width.
- **Other options:** A separate harness case for decisions.
## 2026-11-18 — A worker's program that is unavailable is not a failure

- **Chosen:** When a worker's program reports itself unavailable (the adapters' `unavailable`: a used-up subscription, a
  rate limit, a failed login, an overloaded or failing service), the runner ends the attempt with a new event,
  `unavailable`, carrying the reason, the time the program gave (or none) and the ids of messages it held back and never
  gave to the program. The hub keeps the attempt in a new state, `unavailable`, with the reason, and continues the ticket
  by itself on the next provider. It is not a failure: nothing goes through the failure loop, no guided round is counted,
  the brain is not asked to guide, the ticket stays working. A crash, an error, a refusal or an unknown model stay `program`
  failures. A hub with no start defaults to route with (only the unit tests build one) still ends the attempt as a
  `program` failure, as before. This overturns the part of "A worker that fails, and the place left for the failure
  loop" and of "What a failure is, and what counts as a guided round" that put a program's running out of allowance
  among the `program` failures; a `program` failure now means the program went wrong, or that no provider could take
  over at all.
- **Why:** The owner's reasoning is that an unavailable program is what the brain already switches away from, and the
  system's first priority is unattended work with no blocking points. Counting it as a guided round called the brain, and
  after three rounds the owner, for something nobody could fix by guidance.
- **Other options:** Leaving it a `program` failure and having the brain switch providers by guidance; the runner choosing
  the next program itself.

## 2026-11-18 — The hub decides which provider takes over, and where

- **Chosen:** The hub decides (`routeProvider` in `packages/protocol/src/providers.ts`, called by `WorkService`): it
  holds the owner's order, the start-defaults table, what each online machine offers, the marks and the allowance
  readings, and the runner holds none of them. The order is the owner's order of providers in 设置 (GPT and Claude as
  the owner set them, Claude first until changed, DeepSeek last), mapped to Codex, Claude Code and `dsh`; for prose,
  Antigravity comes first and the code providers follow in that order. The first provider in that order that is not
  out is taken, with the model and effort the table gives for that provider and the ticket's difficulty, on the
  ticket's own machine when it has the program offering that model and effort, and otherwise on another online machine
  that fits the ticket's platform (most free slots first), but only for a code ticket, whose branch the old machine
  first commits and pushes: the new attempt waits for the old machine's `stopped` event, as a move by the owner's
  改派 already does. A task ticket never moves: its scratch folder, output and any change it made on its machine stay
  there, and a deployment's machine is fixed by its file. When the machine lacks the next program, the next provider in
  the order that it has is taken. A ticket whose machine is offline is not moved, since its unpushed work would be
  left behind: it waits for the machine. Only when no provider in the order is offered anywhere with the table's model
  and effort does the attempt fail, as a `program` failure whose reason says so, which goes to the brain as any
  failure does and counts as a round; a provider that is offered but marked unavailable is a wait, never a failure.
  When a worker stopped on a provider and that provider becomes available again before anything else is, the same
  program continues in the same session (recorded as `resumed`).
- **Why:** The hub already resolves the start defaults from the same inputs, so the switch is the same resolution made
  again with a provider taken out. Moving only code tickets is what the existing move between machines can carry; a
  task's work is not in Git.
- **Other options:** The runner choosing, which has no table and sees one machine; moving task tickets and starting
  them again from scratch; failing when the machine lacks the next program.

## 2026-11-18 — What the new program is given

- **Chosen:** The new program cannot resume the old session, so it starts a fresh one in the same folder with the task
  again (a chain's issues, with the already closed ones marked, or the task and its material) and a note from the hub
  that says plainly that an earlier worker on another program worked there and stopped because its provider became
  unavailable, with the program's own reason. The note carries what the hub has: the branch, the pull requests handed
  in or merged with the issues each closed, the issues closed and still open, every message of the owner or the brain
  that the earlier workers were given (with the names of their attachments), how many messages it had not read, and the
  end of the earlier worker's own output (the last 8000 characters, as the failure loop hands the brain), labelled as a
  record and not instructions, and the decisions already recorded for the ticket, which the new worker is told not to
  hand in again (the hub keeps one copy of a decision handed in twice) nor to reverse without a reason; decisions the
  earlier worker made but never handed in exist only in its output, and the note tells the new worker to hand in those
  that still stand. The runner adds what only the machine knows, read when the program starts: the commits
  on the branch that are not on the default branch and `git status --short`, or for a task the files in the output
  folder and the checkout's status. A task ticket's output folder is kept when a program takes over (it is still cleared
  for a plain new attempt). Messages the earlier worker had not read stay with the hub and are sent to the new attempt;
  messages the runner held back for its program and never gave it (queued for `dsh`, or between turns) are named in the
  `unavailable` event, taken back as not delivered and sent again. The files the owner attached to messages are sent
  again in one message from the hub, so a worker on another machine has them too. A first attempt that never ran
  (its provider was already marked at the start) gets no takeover note; a guided round's guidance that never reached a
  worker is kept in the note.
- **Why:** The brief asks for a plain account and the state it finds; the hub has the chain and the messages, the
  machine has the folder. Passing the end of the output is the cheapest way to say what the worker was in the middle of.
- **Other options:** No account of the earlier worker at all; its whole output; the earlier session's transcript.

## 2026-11-18 — The hub's marks, and how they join the allowance readings

- **Chosen:** The hub marks a provider unavailable (`provider_marks`, one row for each of `codex`, `claude`, `dsh` and
  `antigravity`) when a worker's program reports it, from the time of the report. A mark lasts until the time the
  program gave. With no time it is held for ten minutes, the interval of the allowance readings, and then the program is
  tried again, so that a provider with no way to be read (`dsh`, Antigravity) and no reset time is never lost for good.
  A mark clears earlier when a later attempt on that program succeeds (a worker of that program ends a turn, hands in or
  delivers after the mark was made) or when a reading taken after it shows the subscription available. A mark is never
  made by a reading, and an unknown reading is neither a mark nor used up. The readings still say what is left; the
  marks say what a program really answered. For choosing an engine the two are folded: a subscription that is used up by
  its reading or marked counts as used up in `defaultEngine`, so Claude and Codex both out, by either, is `dsh`; a mark
  on `dsh` or Antigravity changes only the switch (and a prose ticket whose Antigravity is marked defaults to the first
  free code provider in the owner's order). The marks appear in `GET /api/allowance`, in the brain's `read_allowance`
  and in 设置's 连接, where each provider's row shows 工作者暂不可用 with the time it is tried again. This
  extends "When a subscription counts as used up", whose rule that an unknown reading is not used up is unchanged.
- **Why:** The owner asked whether two unreadable subscriptions are not simply unavailable. An unreadable allowance mostly
  means no machine could ask, so it stays "not used up"; what proves a provider is unavailable is the program saying so
  when it is called, and that is what the mark records. The brain's own marks (its container and its logins) are separate
  and still shown by the brain's row, since workers use their machines' logins.
- **Other options:** Treating an unknown reading as used up, which makes a PC that is off send the work to DeepSeek; no
  early clearing; keeping the marks in memory; a mark with no time that holds until a reading says otherwise, which
  leaves a provider no reading can speak for out for ever.

## 2026-11-18 — The owner's explicit choice, and tickets started while a provider is marked

- **Chosen:** A ticket whose chosen provider is marked unavailable when its attempt is about to start is switched away
  from at once, even when the owner chose the provider on the card: the queued attempt ends as `unavailable` with the
  mark's reason, never having run, and the ticket continues through the same routing. The ticket's choice becomes the
  new provider, model and effort, recorded as the default's and not the owner's (the owner's own selection stays on
  record as theirs), and the timeline says in Chinese that the owner's choice was switched away from, with the reason
  as the program gave it. The start card still shows the owner's choice until the start; the card of a chain with no
  owner's engine defaults to the next provider while a mark is active.
- **Why:** The brief puts unattended work first, and an owner's choice that is unavailable would otherwise block the
  ticket on the owner.
- **Other options:** Holding the owner's choice and waiting for it; asking the owner.

## 2026-11-18 — When every provider is unavailable the ticket waits

- **Chosen:** When every provider that could run the ticket is unavailable (Claude Code, Codex and `dsh` all marked or
  used up; for prose also Antigravity), the ticket stays working and waits: its latest attempt is the `unavailable`
  one and there is no newer attempt. It is not a failure and no round is counted. The hub tries again by itself with each
  dispatch: when a runner reports, when a mark or the table changes, and on a timer of thirty seconds (injectable, so
  tests use no real time). It continues as soon as one provider is out of the way: at the earliest time any mark gave
  (or the ten-minute hold), or when a reading shows one back. The brain is told once when the wait starts, in the
  ticket's conversation, with every provider's reason and when the hub will try again, and is asked for nothing; it is not
  told again while the wait goes on. The ticket's timeline shows the wait and, later, the switch (or the same provider
  coming back), and 工作台 shows 等供应商.
- **Why:** Waiting is the outcome that needs nobody; a failure would call the brain and, after three rounds, the owner.
- **Other options:** Failing the ticket; telling the brain at every retry; a longer fixed back-off.

## 2026-11-18 — A provider that is marked is not tried again, instead of a count

- **Chosen:** There is no limit on how many times one ticket may switch. What keeps two providers that both fail in
  turn from handing a ticket back and forth is a rule about state: a provider marked unavailable is not tried again
  until its mark clears. The second provider's failure marks it, the first is still marked, so the ticket waits; it
  goes on only when a mark ends.
- **Why:** The house rule: no caps unless something would loop for ever, and a count would stop a ticket that is
  switching because providers really come and go over days.
- **Other options:** A cap on switches for each ticket.

## 2026-11-18 — Handing the folder to another machine waits for the old one, also after an unavailable attempt

- **Chosen:** When a ticket moves to another machine after an attempt that ended `unavailable`, the old machine is told
  to commit, push and remove its worktree, and the new attempt waits for its `stopped` event, as it does after a move
  by the owner while the attempt runs. A runner now also reports `stopped` for a worker that had already ended when it
  is asked to save, which it did not before (so the hub would otherwise wait for ever). The wait applies when the
  attempt started on that machine; an attempt that never ran there is not waited for.
- **Why:** The new machine starts from the branch on GitHub; starting before the push would lose the earlier work.
- **Other options:** Having the runner push before it reports `unavailable`, which would commit work that stays on the
  same machine when it is not moved.

## 2026-11-18 — The timeline, the phase and the owner's reply

- **Chosen:** Each switch is a row of `ticket_switches` (kind `switched`, `waiting` or `resumed`; from and to provider,
  machine, model and effort; the program's reason as it gave it; the time; whether the owner had chosen the
  provider; the attempt that followed) and part of a ticket's detail. The timeline shows it between the attempts in
  Chinese (换了供应商, 等可用的供应商, 供应商恢复了) with the reason in the raw text under it. A ticket waiting for a
  provider shows 等供应商 and its reason, and the owner can still reply to it: the message waits for the next attempt.
  An attempt's provider, model and effort stay on its row, as before. Migration 26 (25 is the decisions's `ticket_decisions`) adds `provider_marks`,
  `ticket_switches` and `ticket_attempts.takeover`.
- **Why:** The brief asks for the switch and its reason to show; a row of its own survives when no attempt follows.
- **Other options:** Deriving the switch from the attempts; a move in the ticket's state history.

## 2026-11-18 — What was verified of the switch of provider

- **Chosen:** Verified in tests with the fake programs the adapter and runner tests already have, and with no real
  subscription touched: a Claude Code worker on a chain's second pull request whose program reports its limit continues
  on Codex on the same machine with the takeover note and no round, no failure and no word to the brain; the move to
  another machine waits for the old machine's push; a task ticket stays; both Claude and Codex out go to `dsh`; the
  owner's order; an owner's choice switched away from; the wait, its single notice and its retry on the injected timer,
  by a time, by a reading and by a success; the same program coming back in the same session; two flapping providers
  not handed back and forth; prose falling from Antigravity to the code providers; messages and files carried over; the
  runner's event, its held-back messages, its folder state and its save after an end; the page's timeline, phase and
  连接. Not verified: a real limit of Claude Code, Codex or DeepSeek (none was hit, since the owner's subscriptions must
  not be used up for a test), a move of a real worktree between two real machines through this path, and macOS.
- **Why:** The brief asks to say what was and was not checked.
- **Other options:** None.

## 2026-11-18 — Leftover merge conflict markers fail the check

- **Chosen:** `pnpm comments` (the zero-comment tool, which already reads every file git lists) also fails when any such
  file, of any language, has a line that starts with seven `<` or seven `>` characters, and names the file and line. A
  line of seven `=` characters is not matched, since a Markdown heading underline can be one; binary files are skipped.
  The tool's report says how many markers it found next to its comment findings.
- **Why:** One slipped into `main` through a pull request whose checks were green, because no check looked for it.
- **Other options:** A new tool of its own; matching the `=======` line too, which would flag Markdown.

## 2026-11-18 — Giving up a stuck ticket opens a repair ticket

- **Chosen:** At the owner's decision, 放弃 on a stuck ticket no longer ends the matter. `TicketService.giveUp` does, in
  one transaction, what the stop did before (the ticket moves from `stuck` to `stopped` with the reason "引导到上限后，你放弃了它")
  and opens a repair ticket for what remains: a new ticket of the same form, kind, difficulty, platform, repository and
  pinned machine, in the same conversation, `pending`, with no machine, engine, model or effort chosen and no owner's
  choice. The hub never starts it; the owner's 开始 does, like any ticket. The three-round stop is unchanged and nothing
  is started without the owner. A repair of a repair needs nothing special: it is the same operation again on the
  repair ticket, and the lineage (`TicketService.lineage`, oldest first) is what makes it readable. When nothing remains
  (a code ticket with every issue closed, which a stuck ticket never is) the ticket is only stopped. `停止` on a running
  ticket is unchanged, deliberate and opens nothing. This overturns the give-up part of "The owner's answer, and the card
  in 等你" (which stopped the ticket, removed the worktree and left nothing following), the part of "The stop at the cap
  is a state of its own" that offered "using `stopped` and opening a new ticket on resume" as an option not taken (the
  new ticket now follows giving up, not resuming), and what "The ticket and its states" says of a stopped ticket's work
  being "a new ticket for the same issue, which is allowed": the hub now opens it. A stopped ticket is still final; the
  repair is a new ticket.
- **Why:** The owner's words: after giving up, a ticket is reopened automatically, linked to the pull request of that
  time, and marked as a repair ticket; the next ticket continues the unfinished work. Doing both in one transaction means
  no state exists in which the owner gave up and nothing follows, and what waited on the ended ticket is never told as
  blocked.
- **Other options:** The brain opening the repair after the stop (a step that can be skipped, and a window with nothing
  following); opening it already started (the owner's 开始 is not skipped, and "Three failed rounds and then I decide"
  stands); a flag on the ended ticket instead of a ticket of its own; special treatment for a repair of a repair.

## 2026-11-18 — What a repair ticket holds, and how it is linked

- **Chosen:** Migration 27 adds `ticket_repairs` (the repair ticket, the ticket it repairs with a unique constraint so a
  ticket has at most one repair, who opened it, the owner's words, the time, and a snapshot of how the repaired ticket
  was stuck: the round, the failure, the failure's detail and the brain's `describe_stuck` text, none of which survives
  on the ticket once it is stopped, plus whether its folder was saved). `Ticket.repairs` and `Ticket.repairedBy` carry
  the link both ways to the page, `read_ticket` and `list_tickets`. A chain's repair holds the issues still open, in
  their order, and the branch of the ticket it repairs, and nothing of its pull requests: its worker hands in the open
  pull request again, and that becomes the repair's own row; the ended ticket's rows stay as they were, which is the
  true record of that time. A task's repair holds the task, its material, its commit (the resolved one when there is one,
  so `merged` is not resolved again) and its deployment. It copies the waits of the repaired ticket, with the waived ones
  still waived, so a deployment's commit and a chain's earlier waits stay as they were, and the title and summary
  unchanged. A pinned machine is copied; a machine is not pinned for a task that merely ran somewhere, because a repair
  pinned to a machine that failed would wait for ever. `arrange_chains` refuses to regroup a repair ticket (it would lose
  the branch and the link), and a ticket may not come `after` a stopped ticket that has a repair: the message names the
  repair. A decision handed in is kept once across the whole lineage, so a worker that repeats an earlier decision
  adds nothing.
- **Why:** The link, the snapshot and the lineage are the whole account the repair's worker and the owner need, and they
  survive the ended ticket's own columns being cleared; one repair per ticket keeps the lineage a line, not a tree.
- **Other options:** Columns on `tickets` (the snapshot does not belong there); copying the pull request rows (the ended
  ticket would then show a pull request as its own that another ticket merged); moving the decisions to the repair, as an
  arrangement's join does (the ended ticket's decisions are the owner's to review where they were made).

## 2026-11-18 — What the repair worker is given

- **Chosen:** The first attempt of a repair ticket is a takeover (`takeover` true, as for a new provider), with the hub's
  note built from the whole lineage, oldest first: for each earlier ticket its end and its last worker, each guided round
  (the failure it answered and the guidance given, or that it was a retry not counted), how it stopped (the failure and
  its detail, and the brain's description of where it was stuck) and the owner's words when they gave it up; the
  advice that guidance which did not get the work through is usually better not repeated; the branch, the pull requests
  handed in or merged and the issues each closed, the issues closed and the issues still open (the repair's own), the
  open pull request and that continuing it is usual; where the earlier worker's folder is and whether its uncommitted work
  was saved; the decisions of every earlier ticket (not to be handed in again); every message of the owner or the brain the
  earlier workers were given with the names of their attachments, which are sent again in one message of the hub; and the
  end of the last earlier worker's own output. The runner adds what it reads when the program starts, the commits not on
  the default branch and `git status --short`, or a task's output files. A repair worker that itself switches provider
  is given this note after the switch's own, so no later program loses the lineage. Guided rounds count from zero for the
  repair. The hub's note, the guidance for the worker and the brain's guidance say the account is advice and a record,
  not instructions.
- **Why:** The brief: reuse the takeover note, plus what failed. The repair worker is the third party to the failure and
  should not repeat it.
- **Other options:** The earlier worker's whole output; the earlier session's transcript; telling the repair worker only
  the brain's description.

## 2026-11-18 — The folder of an ended ticket is kept for its repair

- **Chosen:** The suggested option, with a safeguard. Giving up tells the machine of the ended ticket's last worker to
  save its folder (commit what is uncommitted and push the branch, `work.stop` with `save` true and `remove` false) and
  keeps it; nothing is removed. The repair's start message carries `folder`, the number of the first ticket of its
  lineage, and the runner works in that ticket's worktree (`<name>-t<folder>`) or, for a task, its scratch folder, while
  the repair's own record (`work/t<repair>`, hand-back, events) stays under its own number. On the same machine the repair
  is in the folder as it was left, uncommitted changes and installed dependencies included; on another machine it starts
  from the pushed branch, as a move does, and the note says so. The hub removes the folders of every ticket of a lineage
  once the last one has ended, whatever the end (merged, delivered or stopped), by the same message and the same
  reconnection rule as before: a runner holding the work of an ended ticket whose lineage is still open is left alone.
  No start waits for the save: a runner that restarted since the worker ran has lost its credentials for the push and
  reports nothing, an offline machine cannot answer, and a hang there would be a blocking point; the machine's own report
  (`stopped` with whether it saved and why) is recorded and the note says what is known, and where it is not known that
  only what was pushed before is certain to be on the branch. A repair the brain opens for a ticket that was stopped
  earlier finds the folder already removed (a stop removes it, as before) unless its machine was away, and starts from the
  branch. A repair of a task is not pinned to the machine of the earlier work.
- **Why:** The brief's suggestion keeps uncommitted work and installed dependencies; saving to the branch as well covers
  a repair on another machine and a folder lost with its machine. Naming the earlier ticket's folder, rather than
  copying it, costs no disk or time and keeps one worktree per branch, which Git requires.
- **Other options:** A fresh worktree for the repair with the save only; removing the old folder at once (the previous
  behaviour); waiting for the save before the repair starts; copying the folder.

## 2026-11-18 — What waited on the ended ticket waits on the repair

- **Chosen:** In the transaction that opens a repair, every wait on the ended ticket of a ticket that is `pending` or
  `waiting` and has not been waived moves to the repair, keeping its deployment flag (`redirectWaits`, which also
  now covers `waiting` tickets). A pending ticket after the repair is in its start group, so one 开始 on the repair starts
  it too; a ticket the owner already started stays `waiting` and begins when the repair has merged or is done. A deployment
  ticket whose commit is `merged` therefore resolves to the repair's final merge commit, which contains the earlier
  merged work, and `after_deployment` waits for the repair's deployment. The brain is not told those tickets are
  blocked, which the stop used to tell it. A wait the brain or the owner had waived stays waived, and a ticket past
  its wait is untouched. The brain's later repair of a stopped ticket does the same for the waits not yet waived.
- **Why:** The brief: chains and task tickets arranged after the stuck ticket follow the repair instead of being cut
  loose or told to the brain as blocked.
- **Other options:** Leaving them to the brain with `proceed_ticket`; redirecting only the pending ones.

## 2026-11-18 — Start defaults for a repair, and the brain's tool for a stopped ticket

- **Chosen:** The hub's message to the brain says a repair ticket was opened, what it holds, what now waits for it, the
  run that failed, and asks for `choose_defaults` as for any ticket, with advice (not a rule) to prefer a different
  provider or a stronger model than the failed run and to say why in the one-line reason the owner reads on the card.
  The hub does not choose for the brain and does not start the ticket. `open_repair_ticket` lets the brain open the same
  repair for a ticket that stopped with work remaining when the owner asks in conversation; it refuses a ticket that is
  not stopped, a stuck ticket (the owner decides on its card), one joined into another, one that already has a repair,
  and one with nothing left; it is pending like any other and the tool's result carries the same advice. The page-dev
  demo brain answers with another provider and a higher difficulty.
- **Why:** Constraints on the LLM live in hub code and guidance advises; the choice of provider is the brain's, by the
  allowance it can read.
- **Other options:** The hub choosing a different provider by itself; letting the brain stop and repair a stuck ticket.

## 2026-11-18 — 放弃 takes one press, and what else the card and its notices say

- **Chosen:** 放弃 on the stuck card is answered with one press, like 继续, 确认 and 拒绝; the page's arming step is gone
  (`arm`, `disarm` and the `armed` card step), since nothing is destroyed. The label stays 放弃, the owner's word. A
  shorter label that reads truer to what now happens, "转补救", is proposed and not applied. The notice in the conversation
  now says 你放弃了工单 N，已开补救工单 M，等你开始; the stopped ticket's reason stays 引导到上限后，你放弃了它; the
  brain's message and the stuck notice describe the new behaviour. 停止 on a running ticket still takes two presses. The page
  shows a repair ticket by a 补救 chip on its start card, its row in 工作台, its row in 历史 and its page, whose header links
  to 接着工单 N; the repaired ticket's header links to 由工单 M 接着做. The word 修复 is taken by the kind `fix`, so the chip
  is 补救. This overturns the second press of 放弃 in "The owner's answer, and the card in 等你" and the sentence in "确认 and
  拒绝 on a held command take one press" that arming "now exists only for a stuck ticket's 放弃".
- **Why:** The two presses guarded a destructive step that no longer exists. The owner's rule: no secondary labels; the
  chip and one link each say it.
- **Other options:** Keeping two presses; a note under the button saying a repair opens; a label that names the repair.

## 2026-11-18 — What was verified of repair tickets

- **Chosen:** Verified in tests: a chain stuck on its second pull request given up through the owner's request
  (the ended ticket, the repair's issues, branch, kind, difficulty, platform and links, no start message, the save message
  and no removal, the brain's message, the card and no stuck card, `read_ticket` and `list_tickets`); a deployment ticket,
  a started ticket and an after-deployment ticket redirected, the start of the repair through the owner's request starting
  the pending ones with it, the repair's start message and its note with every guided round, the brain's description, the
  owner's words, the decisions and the messages, the repair merging to the end and the deployment beginning at its final
  merge commit; no removal while the lineage is open, the removal of every ticket's folder when it ends, and the
  reconnection rule; a repair of a repair, one decision once across the lineage; a stopped ticket repaired by the brain,
  the owner's stop opening nothing, and every refusal; a task ticket repaired with its task, commit and pin; the runner
  working in the earlier folder and scratch folder, saving without removing, surviving a restart, and removing both; the
  page's one-press card, chips and links. Driven in the page through `tools/page-dev` (`/__harness/loop?case=repair`): a
  chain stuck after one merged pull request, given up with one press and words, the repair card with its chip and the
  brain's reason, started, merged to the end, and both tickets' pages linked in 历史. Not verified: a real worker, a real
  push of a real folder, a repair on another real machine, and macOS.
- **Why:** The brief asks to say what was and was not checked.
- **Other options:** None.

## 2026-11-18 — Adding a machine without an unauthenticated route

- **Chosen:** The owner decided that nothing of the hub may be reachable without a signed Access assertion, so
  `POST /runner/enroll`, the install codes, their table (dropped by migration 28) and the protocol's `enrollPath`,
  `installCodeHeader`, `installCodeLifetime`, `installCodePattern` and `Enrollment` are gone. This overturns "How a
  machine with no credentials reaches the hub to be added" (2026-11-17) and the parts of "How the install line puts the
  runner on the machine", "Revoking a machine from the page" (forgetting a pending code) and "The build is complete, and
  what is left for the owner" (the Bypass application) that rest on it. 添加机器 now creates the machine's Access service
  token through `AccessServiceTokens` and its runner token at once, registers the machine with its system and the page's
  origin as its hub address, and answers `{ name, system, command }`; the command is the install line carrying both. The
  hub keeps the service token's id and client id, and the runner token's SHA-256 as before; neither secret is stored.
  When Cloudflare refuses, nothing is added and the page shows Cloudflare's own reason (`502 cloudflare_refused` with
  `reason`); when Cloudflare's credentials hold a character the line cannot carry, the token is deleted again and the
  same refusal says so. A second press for a name already being added, or for an active name, is `409`.
- **Why:** The owner's reasoning: the machine's credentials end up in its own settings file anyway, so having them also
  in the terminal's history adds little, while an unauthenticated entry on the public internet is attack surface that
  has to be defended for as long as it exists; the default is to tighten.
- **Other options:** Keeping the Bypass route with its single-use code (the design it replaces); a second host name for
  enrolment; creating the service token only when the line is first run, which needs an open route again.

## 2026-11-18 — The install line and where its secrets can leak

- **Chosen:** Windows PowerShell:
  `& { $access = @{ 'cf-access-client-id' = '<id>'; 'cf-access-client-secret' = '<secret>'; 'x-runner-token' = '<token>' }; irm -MaximumRedirection 0 -Headers $access -Uri '<hub>/runner/install' | iex }`.
  macOS (zsh, bash or sh):
  `( id='<id>'; secret='<secret>'; token='<token>'; script="$(printf 'cf-access-client-id: %s\ncf-access-client-secret: %s\nx-runner-token: %s\n' "$id" "$secret" "$token" | curl -fsSL --max-redirs 0 -H @- '<hub>/runner/install')" && printf '%s\n%s\n%s\n' "$id" "$secret" "$token" | /bin/sh -c "$script" )`.
  `GET /runner/install` is a runner route like `/runner/release`: it answers only a service identity whose runner token
  belongs to that service token's machine, and gives the script for the machine's stored system (404 for a machine added
  from the command line, which has none). The script holds no secret: its setup line names only the hub, the machine
  and the client id, and the runner's `setup` now asks, after the client secret, for the runner token on the next line
  (`RunnerSetup.runnerToken` is optional). On Windows the script reads `$access` from the line's scope and pipes the
  setup line, the secret and the token to `setup`; on macOS it reads the three values from its standard input and hands
  them to `curl` as `-H @-` and to `setup` on standard input. Everything else of the install is as before: the release
  download, `pnpm install` and the build, `setup`, `install`, and `SUPERAGENT2_RUNNER_FOREGROUND=1` for `run`. What was
  closed: the page shows the line once with a copy control, keeps it only in the form's own state and drops it when the
  machine first connects or the section is left; the answer is `no-store`; the hub writes nothing of it to its log; the
  script prints no credential; neither line puts a secret in a child process's arguments or environment (the
  PowerShell variable lives in the `& { }` block and is gone afterwards; the macOS values are unexported variables of a
  subshell, and `/bin/sh -c` gets only the script); a redirect (Cloudflare refusing) fails the fetch instead of running
  a login page; every value is checked against `[A-Za-z0-9._-]` and the hub against an `http(s)://host[:port]` origin
  before it goes into the line. What is not closed: the line itself is in the clipboard and, unless the shell leaves it
  out, in the terminal's history, as the owner accepted; Windows PowerShell's PSReadLine by default keeps lines naming
  `secret` or `token` out of its history file, but that was not relied on.
- **Why:** Without an open route the credentials can only arrive in the line, so the remaining work is keeping them from
  spreading further on the machine than the settings file they end in.
- **Other options:** Exporting the values as environment variables, which every package script of `pnpm install`
  would inherit; passing them to `/bin/sh -c` as arguments, visible in the process list for the whole install; a leading
  space to keep the line out of a history that is set up to honour it, which zsh on macOS is not by default.

## 2026-11-18 — What the owner sets in Cloudflare, and what the hub checks

- **Chosen:** A separate self-hosted Access application for the host name with the path `runner`, with one policy:
  action Service Auth, Include Service Token Tag `superagent2` = `runner`. The hub creates every service token with that
  tag, so no change is needed per machine and only tokens the hub made pass, not every service token of the account
  ("Any Access Service Token" is the fallback if the selector is not offered). The host's own application keeps only the
  owner's Allow policy; any Service Auth policy it had for runners is removed. The steps, the API token's single
  permission (Access: Service Tokens, Edit) and the removal of an old `runner/enroll` Bypass application are in
  `docs/deploy.md`. The hub reads the new application's audience tag as `ACCESS_RUNNER_AUD` and then takes an assertion
  for it only on `/runner/` and only as a service identity (the runner token check is unchanged), and one for
  `ACCESS_AUD` only elsewhere. Without `ACCESS_RUNNER_AUD` the hub keeps the arrangement before (runners through the
  host's application), so releasing this version changes nothing for a runner that already connects; the value must
  differ from `ACCESS_AUD`.
- **Why:** Cloudflare gives the more specific path precedence and a path covers the paths below it, so one application
  decides all of `/runner/` and a service token never reaches the owner's pages at Cloudflare's level. Each Access
  application has its own audience tag, which lets the hub hold the same line. Cloudflare's real API and a real
  application were not used: the tag selector, the audience in a path application's assertion and the answers of the two
  API calls come from Cloudflare's documentation and are checked only against fakes.
- **Other options:** A Service Auth policy on the host's own application (service tokens would reach the owner's pages
  at Cloudflare, refused only by the hub); "Any Access Service Token"; a policy naming each machine's token, which needs
  a change at Cloudflare per machine; a second host name for runners; making `ACCESS_RUNNER_AUD` required, which would
  stop the hub at its first start after the release until the owner set it.

## 2026-11-18 — How long a machine's service token lasts

- **Chosen:** Cloudflare documents that a service token created through the API without a duration lasts one year
  (`8760h`) and that `forever` makes one that does not expire. When a token runs out Cloudflare refuses it: the runner
  keeps retrying, the machine shows offline in 设置, and nothing says why. The hub now asks for `duration: "forever"`.
  It keeps an expiry when Cloudflare's answer gives one anyway (an `expires_at` with a duration other than `forever`),
  and migration 28 dates every token the hub made before this version at one year after the machine was added. A dated
  token shows 令牌 <date> 到期 on the machine's card, in red within thirty days and as 令牌已过期 after; thirty days
  before, the hub writes a notice into the latest conversation and tells the brain, once per token, checked at start and
  every hour. The fix it names is to revoke and add the machine again.
- **Why:** The longest duration Cloudflare allows is no expiry, which removes the silent failure for every new machine;
  a token is still only half of what a runner needs, and revoking a machine in 设置 deletes it at Cloudflare. Older
  tokens are the ones that can still run out, so they get the date and the warning.
- **Other options:** One year, with the hub refreshing each token through Cloudflare's refresh call before it runs out;
  one year, shown and warned about, refreshed by the owner; asking Cloudflare for each token's expiry, which needs one
  more call the real API was not tried with.

## 2026-11-18 — 设置 › 机器 for the new flow

- **Chosen:** A machine that was added but never connected is an ordinary card: a grey dot, its name, its system (from
  what was chosen at 添加机器 until the runner reports its own), 还没连上过, and 撤销, which revokes it and deletes its
  service token at Cloudflare like any other. The pending-code card and 等待安装 are gone. Under the add form, the line
  with its copy control and one sentence, 在新机器的终端里运行，只显示这一次; it disappears when the machine first
  connects. A Cloudflare refusal shows inline under the form with Cloudflare's reason; the missing-credentials and
  missing-release refusals stay passing notices as before. The token's date shows only for a dated token.
- **Why:** The owner's rule: the layout explains itself. The one sentence stays because "only this once" is not
  something the layout can say, and the reason for a refusal is the one thing the owner needs to act on.
- **Other options:** A dialog for the line; keeping the line until dismissed; a separate list of machines not yet
  connected.

## 2026-11-18 — What the hub answers without an assertion, and a seventh code constraint

- **Chosen:** A test (`packages/hub/src/front-door.test.ts`) walks every route the server knows (every exported path
  constant of the hub's server and of the protocol, every page address, a sample of every parameterised route, the old
  `/runner/enroll`, `/runner`, `/runnerx` and an unknown path), with GET, HEAD, POST, PUT and DELETE and socket upgrades,
  without an assertion: everything is 403 except `GET` and `HEAD /health`, which answer status and version only. The
  brain's routes are 403 without the brain's token. `/health` stays open at the hub because `deploy.sh` checks it on the
  NAS without Cloudflare; through the host name it is behind the owner's sign-in. `docs/design.md` gains code constraint
  7, nothing without the front door.
- **Why:** The owner's rule needs to hold for any route added later, so the test reads the route constants instead of a
  list of its own.
- **Other options:** Requiring an assertion for `/health` too, which the release's health check cannot give.

## 2026-11-18 — Adding and revoking a machine by hand on the NAS

- **Chosen:** The hub's command line of #9 (`node dist/machines-cli.js` in the hub's container, run with `docker exec`
  by whoever signs in to the NAS) now does what 添加机器 and 撤销 do, through the same `MachineAdmin`:
  `add <name> --system <windows|macos> --hub <url>` creates the service token through `AccessServiceTokens` (named,
  not expiring and tagged as the page's are), makes the runner token, registers the machine with its system and address,
  and prints the install line for that system once; `revoke <name>` revokes and deletes the service token the hub made.
  A missing Cloudflare setting, a missing version or Cloudflare's refusal is refused with the page's reasons, in English,
  with a non-zero exit, and nothing is added. `add <name> --access-client-id <id>` keeps the setup line of #9 for an
  existing token. The command is not a route: neither the server nor the hub imports it, which a test checks besides the
  front-door walk. This overturns, in "Adding and revoking a machine" (2026-11-17), that `revoke` keeps the token at
  Cloudflare, that a new token gets Cloudflare's default lifetime and that `add` prints the setup line with the secret.
- **Why:** The owner asked for the deployment and the runners to be set up while asleep, and 添加机器 needs the owner's
  own sign-in. One mechanism, reached two ways, keeps the hand-made machine identical to one added from the page.
- **Other options:** A separate script that writes the database directly; an HTTP route for the orchestrator, which
  would be the kind of entry the owner just removed; printing both systems' lines, which would leave the machine's
  stored system, and so the script it is served, undecided.

## 2026-11-18 — What was verified of adding a machine without an open route

- **Chosen:** Tests: the front-door walk above; the line for each system, its refusal of unsafe values, and running
  it for real in Windows PowerShell on Windows and in `/bin/sh`, zsh and bash elsewhere against a local server, which
  checks the headers sent, that the script receives the three values, that they are not in its environment and that
  the PowerShell variable is gone afterwards; adding from the page (the stored hashes and ids, no secret in the database
  file, the never-connected card), the install route's refusals (no assertion, the owner's, the host's audience, another
  machine's token, a machine without a system), Cloudflare refusing and a credential the line cannot carry, revoking a
  machine that never connected, migration 28 on a database at 27, the expiry warning once a month ahead and none for a
  token that does not expire, the runner's setup taking the secret and the token on the next lines, and the Cloudflare
  client's request body. In `tools/page-dev` (fake Cloudflare, `--announce` at this branch's first commit,
  `--credentials environment` for the release), on this PC: 添加机器 with the fake Cloudflare refusing showed its reason
  under the form and added nothing; with it accepting, the never-connected card appeared with its system and
  还没连上过, and the Windows line, run in Windows PowerShell with a scratch runner home and
  `SUPERAGENT2_RUNNER_FOREGROUND=1`, fetched the script and the release, built the runner, saved the settings and
  connected; the card turned online and the line disappeared. Neither the install's output nor the harness's log held
  the secret or the runner token; the runner's settings file did. The macOS line, run in Git Bash on the same PC, did the
  same for a second machine. Revoking each closed its runner (4003) and deleted its token in the fake Cloudflare, after
  which the same credentials got no assertion and `/runner/install` answered 403; `/runner/enroll` answered 403.
  Nothing was installed to start at login; the scratch runners, their folders and the harness were removed. Not
  verified: Cloudflare's real API and a real Access application (see the entry on what the owner sets), a real Mac, and
  the live system.
- **Why:** The brief asks to say what was and was not checked.
- **Other options:** None.

## 2026-11-18 — The PC and the Mac mini are connected, and what was installed on them

- **Chosen:** After #79 was released on the NAS (commit `2a95204`), both work machines were added by hand with `machines-cli.js add` in the hub's container and the install line was run on each: this PC as `pc` (the name `.superagent2/deployment.json` expects) and the Mac mini as `mac-mini`. The owner had asked for this before going to sleep, so nobody was there to press 添加机器. Each line was kept only in a temporary file on this PC, never shown unmasked, and the files were removed afterwards. Cloudflare let the two new service tokens through to `/runner/install` and `/runner/link` with no change to the Access set-up, so the existing application already admits service tokens; the separate `runner` application with a Service Auth policy and `ACCESS_RUNNER_AUD`, which `docs/deploy.md` describes as the tighter arrangement, was not set up and remains the owner's to do. The Mac mini had no Node.js and no pnpm for its user, so Node.js 24.14.1 was installed from nodejs.org with the checksum checked, the way the macOS pipeline does it, under `~/.local/opt` with links in `~/.local/bin`, and pnpm 12.18.0 beside it; this also made Codex usable there, which is a Node.js script. Both runners start at login (a Run key on Windows, a launch agent on macOS), reported Codex, Claude Code, dsh and Antigravity, and read both subscriptions' allowance.
- **Why:** The owner's instruction was to deploy the latest version and have both runners installed and configured. Trying the new tokens against Cloudflare first, before installing anything, was the way to find out whether the owner's Access set-up needed a change that only the owner can make; it did not. Node.js is what the install script refuses to go on without.
- **Other options:** Waiting for the owner to press 添加机器; installing Node.js through Homebrew, which changes more of the machine than a folder in the user's home; leaving the Mac mini out until the owner had installed Node.js.
- **Not verified:** No ticket has run on either machine yet. The first run of the install line on Windows stopped because the orchestrator had merged the error stream into the output, which Windows PowerShell 5.1 turns into a failure when a program writes to it; run as the page shows it, without that, it worked. dsh on the Mac mini is 0.2.2-rc.1, a newer version than the one the control plugin was tried with.

## 2026-11-18 ? Brain program updates

- **Chosen:** Check npm latest at startup and every six hours; queue new turns while all three programs are checked and
  installed, and activate each successful installation separately from a persistent volume. The image versions are
  the floor, including the dsh prerelease. Failed updates leave the previous version active and retry on the next check.
- **Why:** This keeps the brain current without a deployment, avoids changing files under running programs, and allows
  one provider to update even if another fails. Sessions resume using the hub's existing saved session IDs.
- **Other options:** Scheduled image rebuilds and deployments; updating all programs as one transaction.
