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
