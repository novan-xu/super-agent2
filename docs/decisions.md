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
