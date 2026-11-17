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
