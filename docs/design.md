# Super-agent2 design

## Purpose

The owner states a need to the brain from anywhere. The system carries it to finished work without the owner sitting at
a computer.

## Principles

1. The brain can do anything the owner can. The hub is the brain's hands, not a gate.
2. Every constraint on LLM behaviour lives in code. `AGENTS.md` holds guidance only, and nothing in it is relied on.
3. The code constraints are the closed list in [Code constraints](#code-constraints). A new one is added only after the
   same failure has happened twice.
4. The repository holds code only. No comments, with no exceptions.
5. No issue reviewer, no repairer, and no LLM anywhere in verification.

## Parts

| Part | Where | What it does |
| --- | --- | --- |
| Brain | LLM containers on the NAS | Talks with the owner, clarifies the need, files issues, arranges and starts work, evaluates failures, deploys other repositories, and operates through the hub |
| Hub | A container on the NAS, always on, with no way into the NAS host | Holds the credentials, runs commands for the brain in its own container and on the runners, keeps ticket state, enforces the code constraints, serves the front door |
| Runner | One process on each work machine (PC, Mac mini, others later) | Starts workers and runs the commands the hub sends |
| Worker | On a runner | One LLM session per ticket, in full-access mode, in its own git worktree |
| CI | The existing Woodpecker server on the NAS, with agents on the Mac mini and the PC | Runs the verification rules |

The front door is unchanged: Cloudflare Access with the owner's Google account. The new system takes over the existing
host name at its first deployment, and the first Super-agent is stopped then.

## LLM providers

Every provider is used through its own command-line program. Nothing of ours re-implements an agent or calls a model
API directly.

| Role | Providers |
| --- | --- |
| Brain | Claude through Claude Code first, then GPT through Codex. DeepSeek, through `dsh`, answers only while both are unavailable. The owner can change the order of the first two in 设置. |
| Worker, code | Codex, Claude Code and `dsh`. |
| Worker, writing | Antigravity: translation, articles, emails and other text work. Any writing that concerns code is code work and stays with the code workers. |

## The brain's session

Talking to the brain feels like a session of Codex or Claude Code left open, not like sending requests to a service.

- A conversation is one long-lived session. It keeps its context from one message to the next, for days.
- The owner sees the brain work as it happens: what it reads, what it runs, what it writes.
- The owner can send a message while the brain is working, and can interrupt it. Codex and Claude Code take both
  natively; `dsh` through a small plugin this repository ships and mounts at each start.
- A session whose context grows long is compacted by its program, and goes on.
- A restart of the brain, the hub or the NAS resumes the same session.
- When another provider takes over, its session is given the conversation so far.
- The owner can open a new conversation and return to an earlier one.

## The brain's reach

The hub gives the brain one general capability: run a shell command on a target and return its output. The target is the
hub's own container or a runner. Commands run with the owner's credentials: both GitHub accounts with administrator
rights, Woodpecker, Cloudflare, and deployment access through runners.

The reach ends at this project's containers on the NAS. Administrator rights inside the hub's container are intended;
administrator rights over the NAS host are not. No target runs on the NAS host, the hub's container holds no key to
sign in to it and no Docker socket, and the hub does not deploy Super-agent2 itself, which is deployed on the NAS by
hand.

Shortcuts for frequent operations (file an issue, arrange chains, merge, deploy) are built on that same path. They are
conveniences and never the boundary: anything without a shortcut is still possible through a command.

Two things follow:

- The hub container is not hardened in ways that block operations inside it. It has a writable file system, passwordless
  `sudo`, and shell access to every runner. Its mounts are its own volumes, the instance's project folders, and nothing
  else of the host.
- GitHub carries no rule the owner's token cannot bypass. Merging with checks skipped is an ordinary operation.

## Ticket flow

1. **Conversation.** The brain examines the exchange before filing anything. It asks only when the answer changes what
   gets built; otherwise it makes a reasonable assumption and writes it into the issue.
2. **Issues.** The brain files one GitHub issue per piece of work. An issue is the single hand-off: the worker knows only
   its issues and the repository.
3. **Arrangement.** As it files them, the brain arranges the issues into chains and chooses each chain's start defaults.
4. **Start.** The owner presses 开始 on a chain's card. One start starts the whole arrangement.
5. **Work.** The hub creates a git worktree on a new branch and starts a worker in full-access mode. The worker works
   through the chain's issues in order, runs the tests itself, and resolves conflicts with the default branch itself. It
   decides how many pull requests to open: whenever a piece of the chain is ready, it opens a pull request that closes at
   least one of the chain's open issues, hands it in, and waits.
6. **Verification.** Rules only, for each pull request as it is handed in; see below.
7. **Merge.** Automatic when the rules pass. A conflict at merge time goes back to the worker, every time it is found.
   It is never a failure and never counts as a guided round; the ticket says how many times it went back. The hub
   closes the issues the pull request closes, as GitHub lists them.
8. **Continue.** When issues of the chain are still open, the hub resumes the same worker, in the same session and the
   same folder, on a new branch from the updated default branch, and tells it what merged and what remains. The brain
   is not part of this.
9. **Report.** The ticket is merged when every issue of its chain is closed by one of its merged pull requests. It
   reports to the brain once, with the pull requests merged, the final merge commit and whether the change needs
   deploying.
10. **Failure.** At any step, the hub hands the failing output to the brain. The brain writes guidance, and the worker
   tries again. What is already merged stays merged.

A writing ticket has no repository: the worker's text is delivered to the owner in the conversation, with no pull
request and no verification.

## Chains

The chain is how work is scheduled. A ticket is one chain: one or more issues of one repository in working order,
handed once to one worker, which opens as many pull requests for them as it sees fit, one after another. The smallest
ticket is a single issue. The issue is what the owner manages; the brain decides how issues are arranged into chains.

- Each pull request comes from its own branch, named by the hub, in the ticket's one worktree. The hub recognises a
  pull request as the ticket's when its worker hands it in from the ticket's current branch.
- The ticket records its pull requests in order, each with its state and the issues it closed, and which issues are
  still open. A chain that stops keeps what is merged, and the ticket records what remains: the open pull request and
  the open issues.

- The brain puts on one chain the issues that depend on one another, and the issues that cannot be worked on at the
  same time because they touch the same code.
- Independent issues go on separate chains, and those run in parallel.
- A chain is cut where the next issue is in another repository, needs another platform, or needs the earlier work
  merged or deployed first. The issues after the cut are a ticket of their own that waits for the earlier ticket.
- Only the owner starts a chain, with 开始 on its card. The brain arranges and proposes; it has no way to start one.
- Starting starts everything arranged: tickets with nothing before them begin, and each waiting ticket begins by itself
  when the tickets before it have merged, that is when every issue of them is closed.
- A started chain is closed. Later work is a new ticket after it.

## Start defaults

For each chain the brain chooses, once, where and how it runs: machine, engine, model and effort, for example Mac mini,
Codex, `gpt-6.1-sol`, high. They are defaults: the owner can change any of them on the card before the start, and the
owner's choice wins. The card has one select for each, in that order; the page calls the engine 供应商.

The brain decides from four things.

| Input | Values | Decides |
| --- | --- | --- |
| Kind | `writing`, `parameter` (a value, constant or copy change with no logic change), `fix`, `feature`, `refactor`, `maintenance` (dependencies and CI) | Pure prose goes to Antigravity; everything else to a code engine |
| Difficulty | Mechanical: a fixed procedure with a known result. Standard: bounded implementation or diagnosis. Complex: reasoning across modules, state or concurrency changes, or an open design decision. A chain takes the highest of its issues. | The model and effort, through the table below |
| Platform | macOS, Windows, or any | The machine |
| Subscription allowance | What is left on the GPT and Claude subscriptions | The engine. DeepSeek is chosen automatically only when both are used up. |

Light personal tasks and deployments are not tickets: the brain does them itself.

Model and effort by engine and difficulty. These are the starting values, taken from the first Super-agent's settings;
the owner edits them in 设置.

| Difficulty | Codex | Claude Code | dsh |
| --- | --- | --- | --- |
| Mechanical | `gpt-6-luna`, medium | `claude-haiku-5-5`, medium | `deepseek-flash`, low |
| Standard | `gpt-6.1-terra`, high | `claude-sonnet-5-5`, high | `deepseek-flash`, high |
| Complex | `gpt-6.1-sol`, high | `claude-opus-5-5`, high | `deepseek-flash`, max |

Antigravity runs `gemini-3.8-flash` at high for every difficulty.

The brain's own starting values:

| Provider | Model | Effort |
| --- | --- | --- |
| Codex | `gpt-6-astra` | high |
| Claude Code | `claude-opus-5-5` | high |
| dsh | `deepseek-flash` | high |

A model and effort the chosen machine's program does not offer is refused, never replaced by a neighbour.

## Memory

The memory carries what the owner wants kept from one conversation to the next. It belongs to the owner.

- Each memory is one text, in Chinese, stored exactly as the owner wrote or confirmed it. The page shows it as it is,
  line breaks included, and the brain is given exactly that text.
- The owner adds, edits and deletes memories in 记忆, with no limit and no refusal: whatever the owner saves is what is
  stored. Only a blank box is not saved.
- The brain only suggests. Its `remember` creates a suggestion, which may name the memories it replaces; its `forget`
  suggests removing one. Suggestions wait in 记忆's 待确认 until the owner presses 确认 or 不要, and the navigation shows
  how many wait. Nothing else waits on them, so they are not notices.
- The hub refuses a suggestion whose text is the same as a memory, as a suggestion still waiting, as one the owner
  declined, or as a memory the owner deleted. "The same" ignores white space, punctuation of either width, letter case
  and invisible characters. Two wordings of one meaning are left to the brain's judgement.
- The hub also refuses a suggestion without Chinese or one that looks like a credential. The brain's suggestions have no
  count or length limit.
- The brain is given the memory, the suggestions waiting and what the owner declined or deleted, at the start of each
  conversation, again whenever any of it changes, and in the answer of every memory tool.

## Deployment

A ticket never deploys. When merged work needs deploying, the brain deploys it through the hub. After a deployment the
hub checks that the service answers its health check, and rolls back to the previous version when it does not. A
deployment's commands run in the hub's container or on a runner; a deployment file that names the NAS host is refused.

Super-agent2 itself is the exception. The hub cannot reach the NAS host it runs on, so it does not deploy itself: the
owner deploys a new version on the NAS with `deploy/deploy.sh`, or files work for a worker to do it, and the brain
records the deployment once the owner says it is done.

## Verification rules

Each pull request a worker hands in is verified on its own. The level is computed from its changed files, not judged by
an LLM.

| Change | Rule |
| --- | --- |
| Text and documentation files only | None. Merge. |
| Anything else | The Woodpecker pipeline on the pull request's head is green: tests, build, type check, zero-comment check. Then merge. |

The worker's own test run is part of the work, not a verification stage. The brain can skip the rules when the owner
wants that.

## Code constraints

This is the complete list.

1. **Confirmation of irreversible operations.** Before running any command, the hub matches it against a list. A match is
   held until the owner confirms it on the web page, in the owner's own authenticated session. The brain cannot confirm
   on the owner's behalf. Initial list:
   - delete a repository, or make one public
   - force-push to, or rewrite the history of, a default branch
   - delete a database or a data volume on the NAS
   - delete files outside project folders

   The list matches known forms. It cannot see inside a script, so that part rests on the LLM's own judgement.
   Credentials are not on the list: changing or deleting one is not held. A credential file is a file like any other,
   so deleting one outside project folders is held by the rule above and nothing else about it is.
2. **Retry cap.** After three guided rounds on one ticket without passing, the hub stops the ticket and notifies the
   owner. A merge conflict is not a failure and is not counted. A merged pull request is progress: the count starts
   again for the next one.
3. **Verification rules** before an automatic merge.
4. **Zero comments**, checked in CI across the whole repository.
5. **Start by the owner.** A chain starts only from 开始 on its card, in the owner's own authenticated session.
6. **No reach into the NAS host.** The hub has no target on the NAS host, mounts nothing of it but its own folders,
   and holds no key to sign in to it.

## Tests

No test fails because something took longer than expected.

- No test asserts how long something took, and no test has a time limit of its own. The test runner's per-test timeout
  is off; only the pipeline's overall limit ends a run that hangs.
- Logic that depends on time is tested with a clock the test controls.
- A test waits for an event, never for a duration.

## Attachments

The owner can attach any file to a message, in the conversation with the brain and in a ticket's messages to its
worker: from the photo library, the camera or Files on the phone, by pasting an image, or by dropping files on the
composer on a computer. A message may be attachments alone.

- The page uploads each file as soon as it is chosen, in parts of 8 MiB, each one request; the hub writes each part
  straight to disk and never holds the file in memory or in SQLite. A part that fails is sent again from where the hub
  stopped, so a long video from a phone needs no new start and the message waits in the composer until its files are
  in.
- The hub keeps every attachment in a folder of its own named by a random id, under a name made safe for any file
  system from the one the owner's device gave. On the NAS that store is the `superagent2-brain-link` volume, which the
  brain's container reads at the same place, so the brain is told only the file's path inside it.
- The brain's program is told each file's type, size, attachment id and path under the owner's message, and is given
  the images as images where its program takes them (Claude Code, Codex and dsh). It reads other files with its own
  tools. It hands a file on to a worker by its attachment id, as material of a writing ticket or with a message.
- A file sent to a worker travels to its machine over the runner's link, in parts the runner asks for, and lands in the
  ticket's folder outside the worktree, so it is never committed by accident. A message for a worker whose machine is
  away is kept by the hub and given again whenever the machine comes back, until the worker has it.
- A download is always a download: served as an attachment, with `nosniff` and a sandbox, and an image is shown as an
  image only for the types every browser and program read as images.
- Nothing is pruned.

## Limits

Nothing the owner, the brain or a worker sends has an upper limit of its own: not a message, a task, material, a
reason, a command, a list, or the number and size of a writing worker's files. What remains is physical. One request
body or live message is at most 64 MiB, and a request past it is refused with a plain statement that this is the
system's physical limit. A writing worker's text result too long for one message reaches the owner whole, as a file.
Delivered files go from the runner to the hub in parts the hub asks for, and are kept as files beside the hub's
database. The owner's attachments go to the hub in parts the page sends, and from the hub to a runner in parts the runner
asks for. Clipping of logs and output handed to an LLM, or listed on the page, is not a limit: the full text stays.

## Decisions

A choice that would have been the owner's, made without the owner so that work does not stop, is recorded in
[decisions.md](decisions.md): what was chosen, why, and what the other options were.

## Language

Everything written is English: code, issues, pull requests, commits, documents, and what workers are told.

Everything the software shows the owner is Chinese, and only Chinese. Proper nouns and technical terms may stay as they
are.

- The interface's own text comes from one Chinese catalog.
- The page's markup holds no literal text: every label comes from the catalog, and `pnpm check` fails otherwise.
- Text an LLM generates for the owner to see is kept twice: the English original, which goes to GitHub and to other
  LLMs, and a Chinese copy written at the same time by whoever generated it. That covers a ticket's title and summary,
  a worker's report, the brain's guidance, the reason a ticket stopped, and notices. The page shows the Chinese copy.
- The memory is the one exception: it is the owner's own text, kept once, in Chinese, and given to the brain as it is.
- The brain converses with the owner in Chinese.
- Raw material is shown as it is: command output, logs, code and diffs.

## Notices

What waits for the owner (a held operation, a stopped ticket, a question, a chain to start) shows in 工作台's 等你 and
is sent as a push notification from the web page. There is no Lark channel. The notification for a held operation names
where it runs and the command, cut visibly when it is too long for a push message, and never its environment. The
brain's memory suggestions wait in 记忆, not in 等你, and send no notification.

## Interface

The look and layout follow the prototype in [ui/prototype/](ui/prototype/), copied from the first Super-agent with its
comments removed. It specifies look and layout, not behaviour.

Kept from it:

- warm graphite grounds, in light and dark
- one accent colour, for primary actions, the current item and counts that ask for attention
- state dots in fixed hues that never take the accent colour
- a sidebar on wide screens and a tab bar on phones
- the navigation: 工作台, 对话, 历史, 记忆, with 设置 last
- start cards in 工作台: what can start now, and what comes after it

Changed by this design:

- Held irreversible operations appear as confirmation cards in 工作台's 等你. That is the only place they can be confirmed.
  确认 and 拒绝 each take one press.
- A ticket shows which verification rule applied and which guided round it is on.
- Everything that showed the issue reviewer, the repairer, LLM verification or Lark is gone.

## Stack

| Choice | Why |
| --- | --- |
| TypeScript, strict, for the hub, the runner, the web page and the messages between them, in one pnpm workspace | One language end to end: a message one part sends is checked at build time against what the other part expects. It is also the language LLMs write best. |
| Node.js, current LTS | Runs the same on the NAS, Windows and macOS, and is what the vendors' programs are built on. |
| SQLite for the hub's state | One file, no database server to run or to break. |
| WebSocket between hub and runners, and between hub and page | One live channel in both directions, so the page and the runners react at once instead of polling. |
| React with Vite for the page, styled by the prototype's own stylesheet | The interface library LLMs know best, with the look already settled by the prototype. |
| zod at every boundary | Anything arriving from a runner, the page or an LLM is checked against its declared shape before use. |
| Vitest | Tests, in the same language and tool chain. |
| The vendors' own command-line programs for brain and workers: Codex, Claude Code, `dsh`, Antigravity | Each is a full agent kept current by its vendor. The hub offers its capabilities to the brain as MCP tools. |

## Credentials

Third-party credentials are reused from the first Super-agent's deployment. No code is taken from there. Values are
copied on the NAS from the old secrets folder into the new deployment's secrets folder at deploy time; they never enter
this repository, and `.gitignore` excludes the file types that hold them.

| Credential | Where it lives today | Used for |
| --- | --- | --- |
| `GITHUB_TOKEN_NOVAN_XU`, `GITHUB_TOKEN_NUOFAN_ISLAND` | NAS, `secrets/github.env` | Every GitHub operation |
| `ACCESS_TEAM`, `ACCESS_AUD`, `OWNER_EMAIL` | NAS, `secrets/hub.env` | Checking the front door's sign-in |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_API_TOKEN` | NAS, `secrets/hub.env` | Access service tokens for runners |
| Cloudflare API token, `TUNNEL_TOKEN` | NAS, `secrets/cloudflare.env`, `secrets/tunnel.env` | The host name and its tunnel |
| `WOODPECKER_SERVER`, `WOODPECKER_TOKEN` | NAS, hub environment | Reading CI results and logs |
| The ChatGPT login for Codex | NAS, volume `superagent-codex-home` | The brain on GPT |
| `BRAIN_CLAUDE_OAUTH_TOKEN` | NAS, `secrets/brain.env` | The brain on Claude |
| The DeepSeek account login for `dsh` | On the runners; made once in the brain container | The brain on DeepSeek |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | NAS, `secrets/hub.env` | Push notifications |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | Each runner, `~/.superagent2/runner.env` | A runner passing the front door |

Credentials internal to the system (the brain-to-hub token, each runner's token) are generated fresh. The hub holds no
credential for the NAS host itself. Workers use the
logins of the command-line programs already present on each runner.

The confirmation lock does not guard credentials. Changing or deleting one, a secret, a key, a token, a grant or a
login, runs without confirmation; a credential file is deleted under the same rule as any file. The hub still refuses
credential names as a command's environment variables and credential-looking text in a memory, and still injects the
credentials into each command itself.

## Build order

The work is tracked as GitHub issues under five milestones.

1. **Brain reach.** Hub with the general command channel, the front door and the confirmation lock; the brain's session
   connected to it; the conversation page in Chinese; then deployment on the NAS, taking over the host name and stopping
   the first Super-agent.
2. **Dispatch.** Runners, tickets and chains, start defaults, and workers through to an opened pull request; writing
   tickets; 工作台.
3. **Verification and merge.** Woodpecker rules, automatic merge, the failure loop and its retry cap.
4. **Deployment.** Deployment by the brain with health check and rollback, Super-agent2 itself included.
5. **Interface completion.** 历史, 记忆 and 设置.
