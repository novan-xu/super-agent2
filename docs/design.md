# Super Agent design

The product is named Super Agent; `super-agent2` is the repository name and remains in technical identifiers.

## Purpose

The owner states a need to the brain from anywhere.
The system carries it to finished work without the owner sitting at a computer.

## Principles

1. The brain can do anything the owner can.
   The hub is the brain's hands, not a gate.
2. Every constraint on LLM behaviour lives in code.
   `AGENTS.md` holds guidance only, and nothing in it is relied on.
3. The code constraints are the closed list in [Code constraints](#code-constraints).
   The owner explicitly required the ticket lock and the one-sentence-per-line rule for documents.
   Further additions require the same failure to have happened twice.
4. The repository holds code only.
   No comments, with no exceptions.
5. No issue reviewer, no repairer, and no LLM anywhere in verification.

## Documents

Write document prose one sentence per line without wrapping sentences, so edits to different sentences do not touch the same line and conflict at merge.

## Parts

| Part | Where | What it does |
| --- | --- | --- |
| Brain | LLM containers on the NAS | Talks with the owner, clarifies the need, files issues and opens task tickets, arranges work, evaluates failures, and operates through the hub |
| Hub | A container on the NAS, always on, with no way into the NAS host | Holds the credentials, runs commands for the brain in its own container, keeps ticket state, enforces the code constraints, serves the front door |
| Runner | One process on each work machine (PC, Mac mini, others later) | Starts workers for the tickets the owner starts and runs repository checks requested by the hub |
| Worker | On a runner | One LLM session per ticket, in full-access mode: in its own git worktree for a code ticket, in a scratch folder (with a checkout when requested) for a task ticket |
| CI | The existing Woodpecker server on the NAS, with agents on the Mac mini and the PC | Runs the verification rules |

### Front door

With Access audiences configured, the front door is Cloudflare Access on the existing host name, with four applications and no Bypass rule anywhere.
The host's own application admits only the owner, signed in with Google.
A second application for the path `runner` admits only service tokens the hub made for machines, through one Service Auth policy, so a machine's token never reaches the owner's pages and the owner's sign-in never reaches the runners' paths.
A third application for the path `inbox` admits only service tokens tagged for inbox sources, and the hub checks the source identity and its separate audience on that path.
The same application protects `/inbox/message` for text notices and `/inbox/mcp` for file sends from desktop agents.
A fourth application for `/mcp` uses Cloudflare Managed OAuth and admits only the owner's email.
The hub requires that application's own signed Access assertion and the owner identity on `/mcp`, and the endpoint is disabled when its audience is unset.
Cloudflare handles OAuth discovery, client registration, authorization and token issuance.
The hub verifies each application's own assertion where it belongs and answers nothing without one: the only exceptions are `/health` (status and version, for the NAS's own checks, and behind the owner's sign-in through the host name like everything else) and the brain's routes, which the brain reaches on the NAS's internal network with its own token.
A work machine is added from 设置, or by the same steps with the hub's command line in its container on the NAS: the hub makes its service token and runner token at once and shows, once, a one-line install command that carries them to the machine.
The new system took over the existing host name at its first deployment, and the first Super-agent was stopped then.

Without Access audiences, the hub binds only to loopback and treats requests as `owner@local.invalid` when their `Host` is the bound loopback address or `localhost` on the hub port, their optional `Origin` is one of those HTTP origins, and fetch metadata does not mark them cross-site.
The hub applies this check to HTTP and WebSocket requests before routing them, with public status and version at `/health`.
The brain and runner links still require their own tokens, and the brain token is refused on owner routes.
The inbox, OAuth MCP and Access runner install and release endpoints are disabled in loopback mode.
Access and loopback are mutually exclusive for the life of the hub, including when a tunnel forwards requests over a loopback socket.

## Local edition

`corepack pnpm local` starts a native hub and brain in one Node process and a supervised runner named `local` in a child process.
The installation keeps its own database, memory, brain workspace, runner sessions and credentials under `%LOCALAPPDATA%\super-agent2` on Windows or `~/.super-agent2` on other systems.
`SUPERAGENT2_HOME` overrides this location, and the launcher refuses to use a state folder inside `PROJECTS_DIR`.
The first start writes `local.env` and exits so the owner can set the projects folder.
Further settings use the hub, brain and runner's existing environment names, with port `18180` and the computer's time zone by default.
The launcher and child hold presence sockets so an exited process cannot leave a stale PID that prevents another start.
The launcher restarts the runner with bounded exponential backoff and closes the runner, brain and hub in order when it stops.
The runner uses its usual persisted sessions and reconnect protocol on restart.
The launcher uses Windows PowerShell for brain commands on Windows and a POSIX shell on macOS and Linux.
The same confirmation lock checks Windows cmdlets and native commands that remove files or erase storage.
For each GitHub account the launcher uses its configured token or the token fetched from the local `gh` sign-in for that account.
The local edition can use Cloudflare Access with the same audience and service authentication as the NAS edition.
See the [local installation checklist](local.md) for setup and configuration.

## LLM providers

Every provider is used through its own command-line program.
Nothing of ours re-implements an agent or calls a model API directly.

| Role | Providers |
| --- | --- |
| Mail pre-filter | Codex only, using `gpt-6-luna` at low effort; it never follows the brain provider order or falls back to another provider. |
| Brain | Claude through Claude Code, GPT through Codex, and DeepSeek through `dsh`, in that starting order. The owner can reorder all three in 设置 → 模型. |
| Worker, code | GPT through Codex, Claude through Claude Code, and DeepSeek through `dsh`, in that starting order. The owner can reorder all three in the worker section above the brain order in 设置 → 模型. |
| Worker, task | Prose (translation, articles, emails) goes to Antigravity by default; any other task, a deployment included, to a code engine. Any writing that concerns code is code work and stays with the code workers. Antigravity never runs a code ticket. |

### When a provider is unavailable

The brain switches provider by itself when its program reports itself unavailable.
A worker does the same, decided by the hub.

- When a worker's program reports itself unavailable (a used-up subscription, a rate limit, a failed login, an overloaded or failing service), the ticket continues on the first available provider in the owner's worker order, on the same machine when that machine has the program, with the model and effort the start-defaults table gives for that provider and the ticket's difficulty.
  A code ticket whose machine lacks the program moves to another machine that fits the platform, after the first has pushed the branch; a task ticket never moves.
  Where the machine lacks the next program, the next provider after that is taken.
  This is not a failure: no guided round is counted, the brain is not asked to guide and the ticket does not stop.
  A crash or an error is still a failure.
- The new program cannot resume the other program's session.
  It gets the task again, a plain account that an earlier worker on another program worked in the folder and stopped because its provider became unavailable, and the state it finds: the branch, its commits, uncommitted changes, the pull requests handed in or merged, the issues closed, the messages and attachments the earlier worker was given, and the end of its output.
  Messages it had not read are given to the new worker.
- The hub remembers the provider as unavailable until the time the program gave, or for a short hold when it gave none, or until a later attempt on it succeeds or a newer allowance reading shows it available.
  Tickets started meanwhile default to another provider.
  A mark is made only by a program really answering that it is unavailable, never by a reading: an unreadable allowance mostly means nobody could ask, so it stays "not used up".
  A provider that is marked is not tried again until its mark clears, which is what keeps two failing providers from handing a ticket back and forth.
- A manually selected provider on an unpinned ticket is switched away from too, and the ticket's timeline says so, with the reason.
- A ticket with a provider pin waits for its selected provider to recover.
- Claude Code and Codex both unavailable falls to `dsh`.
  When `dsh` is unavailable too, the ticket waits and tries again by itself when the earliest time passes or a reading shows one back; the brain is told once that it waits.
  Antigravity quota and rate limits apply to the model selected for that run, so prose continues on the next offered model in the Antigravity row.
  Model switches use a new session with the earlier worker's output and the same task folder.
  A model mark clears when its hold expires or a later run on that model succeeds.
  When all models in the row are marked, or when a provider-wide problem such as a failed login marks Antigravity itself, prose falls to the code providers in the owner's order.
  The timeline names the previous model and the reason for the switch, including when the owner chose that model.

## The brain's topics

- The owner talks to the brain in one continuous stream.
  The hub records owner messages on arrival and appends answers as they arrive from parallel topics.
  The sidebar shows the model selected most recently among active turns and the next turn's model when the brain is idle.
  A routed message appears in the stream once its topic is known.
  A topic view shows the messages and work for that topic alone.
- Each topic has its own long-lived program session.
  It answers one turn at a time, independently of other topics.
  Topics share the hub's confirmed memory, tickets, decisions and attachments.
- Each project is one GitHub repository, identified by `owner/name`.
  Each topic belongs to one project or to 日常.
  A new topic from 代码 may temporarily have no repository while it waits for the owner to name one.
  It stays in 代码 while it waits.
  Operations for a single repository belong to its topics in 代码, including secrets, service parameters and configuration.
  Confirmed memory, tickets and the topic board are shared across projects.
- A new ticket stays in its filing topic, following any completed topic merge to its destination.
  Filing repository work in a daily topic moves the topic into that repository when all linked tickets belong to it and the topic passes the claim checks.
  Both a checkout repository and a related project count toward these checks.
  Otherwise the topic keeps its repository or stays in 日常.
  The brain may assign a repository to a daily or pending topic, including another topic at the owner's request; System, merged topics, pending merges and conflicting tickets are refused.
  A repository topic without repository tickets can move to 日常.
  Each move updates the page live.
- A regular repository-less task ticket shows its start card, worker updates, failure notices and delivered text and files in its filing topic.
  工作台 lists regular tickets by their checkout repository or related project and puts unassociated tickets under 日常.
  A light task appears through its messages and result in its project topic or in 日常.
  The result can open the complete worker log.
- The owner sees each topic's work as it happens.
  The owner can send more input while a topic is answering and can interrupt that topic.
  Codex and Claude Code take both natively.
  `dsh` uses the control plugin shipped with the brain.
- A topic opened from an owner message starts with the message's first line or attachment name.
  The hub asks the brain for a short title in the owner's language when it prepares a turn with an automatic title.
  A proposed title takes effect when that turn completes.
  Failed and interrupted turns leave the title available for the next turn to name.
  The brain may update its own title when the subject clearly changes.
  The owner's rename takes precedence, including over a proposal already made in the running turn.
- The owner can rename, merge and archive topics.
  A merge combines the histories and ticket ownership in the chosen destination after the affected turns finish.
  Old topic links resolve to that destination, and its next turn gets the combined history through the seed.
  The destination keeps its repository when the owner combines topics across projects.
  The System topic can receive a merge and keeps its own address.
  The destination's topic actions can undo a recorded merge and restore the source's original history and ticket ownership.
  Messages and work that arrived later stay in the destination.
  This applies to new merges made by the owner or the brain.
- The brain can queue a batch of idle topics for one destination with `merge_topics` during an owner turn or an approved scheduled run.
  Each source must be in the destination's repository or in the same daily scope.
  The tool reports a reason for each skipped topic.
- A topic automatically archives after two hours without a new owner message, brain answer or ticket notice, once it has no running or queued turn.
  The hub checks idle topics every minute or at the configured age if shorter.
  Set `HUB_TOPIC_ARCHIVE_MS` to change the age.
  The hub also reviews similar idle topics daily at 05:00 America/New_York without creating an owner schedule.
  Set `HUB_TOPIC_TIDY_TIME` to an `HH:MM` local time or `HUB_TOPIC_TIDY_ENABLED=false` to disable this review.
  System is exempt.
  An open ticket can stay linked to an archived topic.
  The hub persists any missing finished-turn summaries before archiving, including when a program session is still open.
- Archived topics stay in the stream and searchable history.
  Routing can match topics archived within the past 24 hours that have an owner message or a linked ticket.
  A routed or direct message, quoted reply, move, handover or ticket notice to an archived topic makes it active again.
- Each existing conversation becomes a topic, keeping its history and saved program session IDs.
  It takes a repository if every ticket linked to it belongs to that repository.
  Existing ticket links are preserved, so a topic with tickets from different repositories or with a repository-free ticket stays in 日常.

### Routing

- A message sent in a topic view goes straight to that topic.
  A quoted reply goes to the quoted message's topic and gives the session the quoted message.
  The topic view offers quotes from its own messages, and the main stream can quote across topics.
  Answers to a question card stay in the card's topic.
  None of these is routed.
- In the main stream the hub suggests a destination while the owner writes.
  Sending to the displayed or selected destination counts as owner placement.
  When the send has no destination, the hub routes it with rules and a score without a large-model call (#143, see [routing-evaluation.md](routing-evaluation.md)).
  The candidates are the active and recently archived topics in the composer's scope, except System, merged topics and topics with a merge pending, most recently active first.
  In this order:

  | Step | Rule |
  | --- | --- |
  | a | Open question: the most recently active candidate is waiting for the owner (an unanswered question card, or its last assistant reply has `?` or `？` in its last line within the last 40 characters) and was active at most 30 minutes ago. Join it. |
  | e | Reference: the message names a ticket (`ticket aa` or `工单 aa`), an issue or a pull request (`#n`, `issue n`, `PR n`) that belongs to exactly one candidate. The hub looks up the ticket's topic first, directly by code or through its issues and pull requests. A reference the database does not know matches the candidates whose messages or replies contain it. Join that topic. |
  | b | Short reply: at most 12 characters, no attachment, and the most recently active candidate was active at most 30 minutes ago. Join it. |
  | c | Score: the best similarity between the message and a topic's texts (its first owner message, its last five owner messages and its last three replies clipped to 320 characters), minus `decay × log2(1 + idle / 10 min)`. Join the best topic if it reaches the threshold and leads the runner-up by the margin. |
  | d | Otherwise open a new topic titled with the message's first line, marked as possibly belonging to the best-scoring candidate when there is one. |

- At three or more active topics in a repository, automatic routing can only join active topics.
  If the normal destination would add a topic, the router uses the best available active score for that repository and breaks ties by latest activity.
  A titled brain handover at the cap uses bigram scores and chooses another active topic in the repository.
  The owner can still choose a destination or open a new topic.
- Routing uses the original message text as specified above.
  Topic renames do not affect the score.

- Two configurations exist, with their constants together in `packages/routing`.
  The primary one uses all five steps with `bge-small-zh-v1.5` (fp32, CLS pooling, normalised, compared by dot product) as the scorer, with threshold 0.430, margin 0.050 and decay 0.048.
  The other uses steps b, c and d with character bigrams: threshold 0.055, margin 0.091, decay 0.18.
  `HUB_ROUTING_PRIMARY` (`model` by default, or `bigram`) picks the primary one; the other runs beside it as a shadow whenever it can.
- The hub loads the model in the background after it starts, from the files baked into its image (`HUB_ROUTING_MODELS`, see [deploy.md](deploy.md)), and never downloads it.
  It keeps a vector of every topic text a candidate could be scored on and refreshes them in the background when entries are written, so routing a message embeds only that message.
  While the model is loading or missing, if it failed to load, or if it fails to embed a message, the bigram configuration decides at once and the reason is recorded.
- The model computes one text at a time.
  A send's texts go first, then previews', then the background refresh's; a computation that has started is never interrupted.
  A send waits at most 2 s for the model's decision; after that the bigram configuration decides, the decision records `model busy`, and the texts the send started are still computed and stored.
  A preview whose request has gone is cancelled, and a text it alone waits for is never computed.
- Every routing decision is stored in `routing_decisions` without the message's text: the owner's entry, scope, number of candidates, configuration, any fallback reason, rule, joined topic, the topic the entry was placed in, the best topic with the best and runner-up scores, and the shadow configuration's rule, topic and scores.
  Moving the entry later with 移到… records the destination and time beside the decision, so the owner's corrections become labels for the next evaluation.
  Brain handovers record their own destination and time.
  Separate flags record when the repository cap chose the destination for routing or for a brain handover.
  A later owner move flags that the owner corrected the handover and preserves both destinations.
  The hub also logs one line for each initial decision.
- In 日常 a new topic has no repository; in a repository composer it takes that repository.
  In all of 代码, an unambiguous name or `owner/name` limits matches to that repository's topics, except when the message cites a ticket or issue.
  Known names come from active and recently archived candidates, open tickets including their related projects, and the repository catalog's pinned or discovered repositories.
  A new topic in 代码 uses that repository when named, or waits for the brain to establish the repository with the owner.
- The owner can move a message to another topic with 移到… and use a possible match in one tap.
  A message the hub routed carries a line naming the rule and whether it joined or opened a topic.
  A new topic also gets its possible match's ID, title and up to 320 characters of the match's summary when there is a candidate.
- The brain can hand a routed message over to an existing topic or open one with a title in the owner's language.
  It does so only when the destination is clear and answers in the current topic when unsure.
  Owner-placed messages require an explicit owner request.
  The hub allows each message one brain handover and omits the routing note after it.
- The hub keeps an input in `pending_topic_inputs` while it routes it.
  If the hub restarts before routing completes, the input is routed at startup with the bigram configuration and the decision records that it was recovered.
- The page gives each send an id, which becomes the owner entry's id and the pending input's id.
  A send repeated with the same id and the same text, attachments, quote and named topic gets the entry already placed, or waits for the one still being routed; the same id with other content is refused with 409.
  The page keeps the id with the draft until the send succeeds, and makes a new one when the draft's content or the owner's destination differs.
  A send that gets no answer within 20 s stops, the page says the message may still arrive, and the draft stays for a retry with the same id.
- A move or handover changes where the original message belongs and queues it at the destination.
  Pending work on that message is removed from the source.
  If the source is answering it, that turn is interrupted before the destination handles it.
  The hub archives the source after the move or interrupted turn if it has no owner messages, running turns, queued input or open tickets.
  Earlier replies stay in their source topic and completed work is kept.

### Session lifecycle

- After `BRAIN_IDLE_MS` (two hours by default), the brain closes the idle program with its topic summary saved in the hub.
  It keeps the session ID.
  When a topic needs a slot sooner, the least recently used idle topic closes the same way.
  If all slots are busy, waiting topics keep their inputs until a slot frees.
- The next input resumes the saved session after a close or a restart of the brain, hub or NAS.
  When a program reports the session lost, the topic starts a replacement with the seed.
  A provider taking over gets the same seed and uses its own saved session for that topic when available.
  The program still compacts its own context as it grows.

The brain checks npm `latest` for Codex, Claude Code and dsh at startup and every six hours.
It waits until all turns finish, queues new inputs, closes idle program processes and installs newer versions into a persistent volume.
Each successful install is activated atomically; a failure leaves the previous program in place and is retried at the next check.
The image pins remain the minimum versions, including dsh's prerelease when npm latest is older.
Topics resume their saved sessions through the hub.
The brain container logs updates and failures.

### Session seed

The seed is an index.
The brain reads details through tools.
Completeness comes first, especially for the topic's own history.
The input and its attachments accompany the seed.
The seed goes to new and reopened sessions, in this order.

1. **Quoted message.**
   Include it in full on any quoted turn, including one in a session that is already open.
   If it exceeds the reserved inline quote budget or the provider's input capacity, give its reference and read it in parts with `read_quote`.
   The same rule applies to input steered into a running turn.
2. **This topic's history.**
   Include the whole history when it has at most 50 turns.
   Otherwise include the full summary and the last 50 turns verbatim.
   Keep the summary and newest complete turns when the provider's hard input capacity requires omissions; omit older turns first.
3. **Confirmed memory.**
   Include the owner's confirmed text.
4. **Open tickets.**
   Give one line per ticket, with this topic's tickets first.
5. **Topic board.**
   Give titles and current statuses.

Confirmed memory, open tickets and the topic board are given in full by default, without per-part budgets.
When anything is omitted, state how many items were left out and name the hub tool that reads them.
The hub keeps the complete records.

### Topic board

- The hub keeps each topic's title and a one-line current status.
  It updates the status at the end of each turn and reflects renames, merges and archives on the board.
- At the start of a turn, the topic gets the board entries changed since its last input.
  A new or reopened session gets a board snapshot in its seed.
  A topic can read more of the board at any time.
- Every topic can read another topic's recent messages or summary and search across topic history through hub tools.
  If the owner asks to combine work from two topics, either session can read what it needs.

### Ticket changes

- Each ticket belongs to the topic that filed it.
  A new chain inherits its head ticket's topic, and a repair inherits the repaired ticket's topic.
  A ticket's topic is the destination for its [notices](#notices).
- A topic gets a ticket's lock on its first successful change to that ticket in a turn.
  The hub refuses changes from another topic while the lock is held and names the holder.
  Reads can continue.
- A topic reads an existing ticket before changing it.
  The hub ties the write to the topic turn and refuses it when the ticket has changed since that topic's last read or successful write.
  The topic reads it again before retrying.
  The hub checks the lock and the ticket version together with the write.
  A change that touches several tickets checks and takes the locks for all of them together.
- The hub releases the locks when the turn ends, including on failure or interruption.
  When a turn is lost, the hub ends it and revokes its ability to write before releasing its locks.
  A lock has no time-based expiry.

## The brain's reach

The hub gives the brain one general capability: run a shell command in the hub's own container and return its output.
Commands run with the owner's credentials: both GitHub accounts with administrator rights, Woodpecker and Cloudflare.

The reach ends at the hub's container.
Administrator rights inside it are intended; rights over the NAS host and over the work machines are not the brain's.
No command of the brain's runs on the NAS host or on a runner: the hub's container holds no key to sign in to the NAS and no Docker socket, and a runner runs nothing but the workers of tickets the owner started.
Anything done on a machine, a deployment included, is a task ticket for a worker there.

Shortcuts for frequent operations (file an issue, open a task ticket, arrange chains, merge) are built on that same path.
They are conveniences and never the boundary: anything without a shortcut is still possible through a command.

Two things follow:

- The hub container is not hardened in ways that block operations inside it.
  It has a writable file system and passwordless `sudo`.
  Its mounts are its own volumes, the instance's project folders, and nothing else of the host.
- GitHub carries no rule the owner's token cannot bypass.
  Merging with checks skipped is an ordinary operation.

## Ticket codes

Code and task tickets share the same daily sequence of two lowercase letters, starting at `aa` and ending at `zz`.
The hub determines the creation day in `HUB_TICKET_TIME_ZONE`, which defaults to `America/New_York`.
It saves the unique pair of creation day and code in the transaction that creates the ticket and refuses new tickets when all 676 codes for that day are used.
The migration assigns codes by local creation day, then by creation time and internal key, while preserving existing ticket relationships and branches.
The page displays the letters alone as the ticket identifier.
Brain tools accept a bare code for the newest match or a dated reference such as `aa-2026-11-19` for one exact ticket.
In an arrangement, a chain name in the same call takes precedence over a matching code.
Hub reports and worker briefs name tickets with dated references so they remain clear after midnight.
New code branches use `sa2/aa-2026-11-19-<suffix>`.
The database, page routes, runner messages and folder paths use the stable internal key to keep existing links, worktrees and running workers connected.

## Ticket flow

1. **Topic.**
   The brain examines the exchange in its topic before filing anything.
   When the goal or the scope is unclear, it talks with the owner first, one short question at a time.
   Details of implementation are decided, not asked, and recorded as decisions (see [Choices made on the owner's behalf](#choices-made-on-the-owners-behalf)).
2. **Issues.**
   The brain files one GitHub issue per piece of work.
   An issue is the single hand-off: the worker knows only its issues and the repository.
   It is a fairly complete plan (background, goal, a suggested approach, what is in and out of scope, open points each with a recommended option, and what done means), written in advising language; firm wording is kept for what the owner explicitly required, marked as such.
3. **Arrangement.**
   As it files them, the brain arranges the issues into chains and chooses each chain's start defaults.
4. **Start.**
   The owner presses 开始 on a chain's card.
   One start starts the whole arrangement.
   A confirmed schedule authorizes the hub to start the work opened by each of its runs.
5. **Work.**
   The runner creates a git worktree on a new branch and starts a worker in full-access mode.
   Before starting or resuming a code worker, the runner checks the issue state on GitHub and marks any issue already closed as requiring no work.
   The worker works through the chain's issues in order, runs the tests itself, and resolves conflicts with the default branch itself.
   It decides how many pull requests to open: whenever a piece of the chain is ready, it opens a pull request that closes at least one of the chain's open issues, hands it in, and waits.
6. **Verification.**
   Rules only, for each pull request as it is handed in; see below.
7. **Merge.**
   Automatic when the rules pass.
   A conflict at merge time goes back to the worker, every time it is found.
   It is never a failure and never counts as a guided round; the ticket says how many times it went back.
   The hub closes the issues the pull request closes, as GitHub lists them.
8. **Continue.**
   When issues of the chain are still open, the hub resumes the same worker, in the same session and the same folder, on a new branch from the updated default branch, and tells it what merged and what remains.
   The brain is not part of this.
9. **Report.**
   The ticket is merged when every issue of its chain is settled and at least one of its pull requests merged.
   An issue is settled when a merged pull request of the chain closed it or GitHub shows it as closed for any other reason.
   The hub independently checks GitHub after a merge and when the runner reports that nothing is left to hand in.
   It reports to its topic once, with the pull requests merged, the final merge commit, whether the change needs deploying, and every decision recorded on the owner's behalf.
   The report names issues closed outside its pull requests and includes their GitHub state reasons and any closing comments found in the issue timeline.
   A chain whose issues are all closed without any merged pull request is stopped and reported to its topic.
10. **Failure.**
    At any step, the hub hands the failing output to the ticket's topic.
    The brain writes guidance and the worker tries again.
    What is already merged stays merged.
    When a worker's program becomes unavailable, the hub routes the ticket by its provider settings and leaves the failure count unchanged (see [When a provider is unavailable](#when-a-provider-is-unavailable)).

11. **Stuck.**
    After three guided rounds without passing, the ticket stops and waits for the owner on a card in 等你, who resumes it (a fresh count, with words for the brain) or gives it up.
    Giving up takes one press and destroys nothing: the ticket ends, and in the same step the hub opens a repair ticket (see [Repair tickets](#repair-tickets)).
    Nothing starts without the owner.

There are two kinds of ticket.
Everything above is a code ticket.
Everything else a worker does is a task ticket with instructions, material and attachments.
Use `open_task_ticket` with `project` to associate work with its repository in 代码 while the worker runs in scratch.
Use `repository` when the task needs a checkout, with an optional `commit` to select its revision.
The worker hands back an outcome (done or failed), a report and any text and files.
Done, the result is delivered to the owner in the ticket's topic and the main stream, and the ticket is done (`delivered`).
A failed task goes through the failure loop.
Nothing is verified.
A task ticket can be arranged after a code chain and take that chain's final merge commit as its commit, filled in when it begins.

### Light tasks

Light tasks cover everyday prose, routine machine operations and Agent_wring work in 日常, along with operations for a repository that can be done in scratch in 代码.
Use `project` in `start_light_task` for operations concerning a repository's secrets, service parameters or configuration.
The active topic must already belong to the project or be eligible to move there when the work starts.
The brain calls `start_light_task` as soon as it understands the request and acknowledges the work in one short line.
If the scope or material is unclear, it asks an ordinary question first.
The hub requires an owner message from the same topic in the active turn and permits multiple distinct tasks in that turn.
A repeated identical call in the same turn returns the same task.
Light tasks are standalone and use the existing task ticket, daily code, runner, scratch folder, work events and provider fallback internally.
The hub chooses the machine, model and effort from the usual defaults and starts the task when a suitable machine is available.
An owner can request an engine or stop the worker in the conversation.
Code changes always use issue chains.
Deployments, operations that need a checkout and explicit requests for a ticket use visible tickets.

The conversation shows any worker question and the final result, failure or stop.
The workbench, waiting list and ticket history omit light tasks.
A worker can write a question to its runner and pause until the brain relays the owner's original later message and attachments from the same topic.
The brain can guide retries privately within the existing retry limit.
A final failure stops the task and posts a single message.
The delivered result offers a link to its worker log.

If the result contains files, the hub adds one titled entry to 传输 with the result text and the files.
The conversation also offers the files.
Agent_wring workers save in Agent_wring and report the saved item and summary in the conversation.
Agent_wring article writing uses the Antigravity model order and code fallback, and standalone ingestion, polling and saving without writing use code engines.

### Scheduled work

A schedule stores a title, instructions, timing, an optional repository and work machine, and the topic that receives its results.
Recurring schedules use numeric five-field cron in `HUB_TICKET_TIME_ZONE`.
Service-triggered schedules use `{ "trigger": "<source>" }` and have no next run time.
A single run uses an absolute timestamp and keeps its history after completion.
The schedule records who confirmed its plan and when.

During an active owner turn, the brain calls `propose_schedule` with an English instruction and briefly links to the pending card on 定时.
The owner confirms, edits and confirms, or discards the proposal on 定时.
Pending cards stay until the owner acts or a newer proposal replaces a pending edit for the same schedule.
An edit proposal records the target revision and can apply only while that revision is current.
The hub saves a confirmed plan as a new schedule or revision and posts a confirmation notice in the schedule's topic.
`list_schedules`, `pause_schedule`, `resume_schedule` and `delete_schedule` manage existing schedules.
The owner can also create and edit schedules directly on 定时.

At a due time or on a service trigger the hub records a run and posts its instruction into its topic as a scheduled input.
The brain takes this input in a dedicated turn and decides what the work needs at that time.
It can answer directly, call `run_scheduled_light_task`, open a visible task ticket, or file issues and arrange chains and deployments.
It states defaults for any visible work in that turn.
New tickets carry the run ID, including chains assembled from tickets of that run.
The hub starts those tickets after a successful turn if the recorded schedule revision still authorizes the run.
Work with missing defaults or a pending predecessor outside the run stays available for review.
The usual dependency and machine rules apply, including the deployment recipe's target.
The schedule's machine, when set, applies to its other worker tickets.
Retry, verification and merge follow the normal rules.

Due times accumulate into one run while the hub or brain is offline.
A due time is recorded as skipped while a prior run is queued, its brain turn is underway, or any work it started is waiting, running or verifying.
The topic receives a short skip notice and keeps the run's output.
Pausing, editing or deleting a plan invalidates automatic starts from its older revision.
Work the hub already started continues under its own ticket.

### Service requests

The hub accepts authenticated work requests on the internal Docker listener described in [deploy.md](deploy.md#internal-work-requests).
Each new request joins the pending batch of every active, confirmed trigger schedule bound to that source.
The hub saves the receipt and the fan-out together in SQLite, so a retry with the same source, idempotency key and payload returns the original receipt for seven days.
The request cannot select a schedule revision, set the machine or change the owner's instruction.
The run input contains the confirmed instruction and a JSON block labelled as untrusted service data.
The schedule topic shows the request content under the source name.

Each schedule holds one pending batch while the brain is offline or a previous run is queued, in its brain turn or still has active worker tickets.
The batch becomes a single run when the schedule is ready again.
A full batch rejects new requests with a retryable response and keeps every request it accepted.
Changing, pausing or deleting a schedule clears its pending batch and invalidates unstarted work from older revisions.

## Chains

The chain is how work is scheduled.
A ticket is one chain: one or more issues of one repository in working order, handed once to one worker, which opens as many pull requests for them as it sees fit, one after another.
The smallest ticket is a single issue.
The issue is what the owner manages; the brain decides how issues are arranged into chains.

- Each pull request comes from its own branch, named by the hub, in the ticket's one worktree.
  The hub recognises a pull request as the ticket's when its worker hands it in from the ticket's current branch.
- The ticket records its pull requests in order, each with its state and the issues it closed, and which issues are still open.
  A chain that stops keeps what is merged, and the ticket records what remains: the open pull request and the open issues.

- The brain puts on one chain the issues that depend on one another, and the issues that cannot be worked on at the same time because they touch the same code.
- Independent issues go on separate chains, and those run in parallel.
- A chain is cut where the next issue is in another repository, needs another platform, or needs the earlier work merged or deployed first.
  The issues after the cut are a ticket of their own that waits for the earlier ticket.
- Only the owner starts a chain, with 开始 on its card.
  The brain arranges and proposes; it has no way to start one.
- Starting starts everything arranged: tickets with nothing before them begin, and each waiting ticket begins by itself when the tickets before it have merged, that is when every issue of them is closed.
- A started chain is closed.
  Later work is a new ticket after it.
  To drop an issue, close it on GitHub as not planned with a comment and record the decision.
  If an externally closed issue reopens while the chain is still active, it becomes work again when the issue state is next checked.

## Repair tickets

A ticket the owner gives up (放弃 on a stuck ticket's card) is not abandoned.
In the same step as the stop, the hub opens a new ticket, a repair ticket, that takes over what remains.
The brain can open one for any ticket that stopped with work remaining, when the owner asks for that in conversation (`open_repair_ticket`); a ticket the owner stops with 停止 opens nothing by itself.

- **What it holds.**
  For a chain: the issues still open, on the same branch, so its worker continues the open pull request (or opens a new one when it sees fit); what is merged stays merged.
  For a task ticket: the same task, with its material, its commit and its deployment.
  It keeps the kind, difficulty, platform, repository and a pinned machine, and it waits for what the ticket waited for.
  The ended ticket names its repair, and the repair names the ticket it repairs, and the page, `read_ticket` and `list_tickets` show both links.
- **Pending.**
  A repair ticket starts only with the owner's 开始, like any ticket.
  The brain is told, and states its defaults with `choose_defaults`, including the difficulty reason the owner reads on the card.
- **What waited.**
  Tickets arranged `after` the ended ticket (a deployment ticket after a chain, `after_deployment` included) wait for the repair instead, and the owner's 开始 on the repair starts those not yet started with it.
  A wait that was already waived stays waived.
- **What the worker is given.**
  The takeover note, extended: the account of the folder and the work (branch, pull requests handed in or merged, issues closed and open, the messages the earlier workers were given, the end of the last one's output, the decisions recorded), and what failed: every guided round's failure and guidance, the brain's description of why the ticket was stuck, and the owner's words when they gave it up.
  A repair of a repair is the same thing again, with the whole lineage in the note, and the decisions of the whole lineage are one set.
- **The folder.**
  Giving up saves the ended ticket's folder to its branch (its uncommitted changes are committed and pushed) and keeps it.
  The repair works in that same folder on the machine where it was, uncommitted changes included; on another machine it starts from the pushed branch, as a move between machines does.
  The folder is removed when the last repair of the lineage ends, whatever the end.

## Choices made on the owner's behalf

Nobody is asked anything while a ticket runs.
A worker decides by itself, and the brain decides on the owner's behalf; which of them decides matters less than the record.
The owner reviews the decisions afterwards.

- A decision is something chosen on the owner's behalf where the owner might have chosen differently: what was chosen, why, and what else was possible, each in English with a Chinese copy.
  The hub keeps them per ticket, with who recorded them, so they remain available to every topic and provider.
- A worker hands its decisions in with each pull request, or with a task's hand-back; a hand-in without any is valid.
  The brain records its own with `record_decision`, against a ticket, at any time: its assumptions at filing, how it arranged or cut the work, what it told a worker.
  A decision on a ticket that joins a chain moves with it.
  The same decision recorded twice is kept once.
- When a ticket ends (merged, done, stuck at the cap, or stopped), the hub's report to the brain lists every decision recorded for it, and the brain reports them to the owner in Chinese.
  The ticket's page lists them too, whatever the brain says, so the report does not rest on the brain remembering.
- On the ticket's page each decision shows with 可以 and one box for an opinion.
  可以 settles it; an opinion settles it as not OK.
  When every decision recorded on the ticket so far is settled, the hub sends the ticket's topic one `[hub]` message with every opinion and its decision.
  The brain decides how to group them into follow-up issues, talking with the owner first where the scope of a fix is unclear.
  A review with no opinion sends nothing.
- Nothing waits on the review: no ticket, chain or deployment.
  Finished tickets with decisions to review carry their count in 历史, and 历史 in the navigation carries the total; there is no push notification.

## Start defaults

The hub remembers model IDs seen for each engine across machine reports.
The first nonempty report for an engine establishes a baseline.
Later new IDs in a report are grouped into one notice for that engine in the System topic.
Effort-only changes and disappearing models do not create notices.
The brain proposes a row change and uses `set_engine_row` only with the owner's agreement.
Changed pairs must be offered by an online machine, as for page edits.

For each chain the brain states its kind, difficulty, difficulty reason and platform.
The hub resolves the machine, engine, model and effort.
The owner can change these values on the card before the start, and the owner's choice wins.
The brain records any machine or provider the owner explicitly requests with `choose_defaults` or the light-task tools.
The card marks pinned values, and an approved start waits for the pinned machine or provider and resumes when available.
Pins apply to all issues of a ticket and carry over to repairs, follow-ups and regrouped issues.
Tickets with conflicting pins must remain in separate chains.
The card has one select for each, in that order; the page calls the engine 供应商.

The hub uses these inputs to resolve the defaults.

| Input | Values | Decides |
| --- | --- | --- |
| Kind | Code tickets: `parameter` (a value, constant or copy change with no logic change), `fix`, `feature`, `refactor`, `maintenance` (dependencies and CI). Task tickets: `writing` (prose), `operation` (anything done on a machine) | Prose goes to Antigravity; everything else to a code engine |
| Difficulty | Mechanical: a fixed procedure with a known result. Standard: bounded implementation or diagnosis. Complex: reasoning across modules, state or concurrency changes, or an open design decision. A chain takes the highest of its issues. | The model and effort, through the table below |
| Platform | macOS, Windows, or any | The machine |
| Worker provider order and availability | The order in 设置 → 模型, subscription allowance, the DeepSeek balance and active worker availability marks | The first available engine in the worker order. An unknown allowance counts as available. An empty DeepSeek balance makes dsh unavailable until a later successful reading shows money. |

A code or operation ticket started with every worker provider unavailable waits and resolves its engine again when a provider returns.
Writing tries Antigravity first and uses the worker order for fallback.

What the brain can do in the hub's container needs no ticket; anything on a work machine is a task ticket.
A deployment's machine is the one its deployment file names, and the owner cannot choose another.

Model and effort by engine and difficulty.
These are the starting values, taken from the first Super-agent's settings; the owner edits them in 设置.

| Difficulty | Codex | Claude Code | dsh |
| --- | --- | --- | --- |
| Mechanical | `gpt-6-luna`, medium | `claude-haiku-5-5`, medium | `deepseek-flash`, low |
| Standard | `gpt-6.1-terra`, high | `claude-sonnet-5-5`, high | `deepseek-flash`, high |
| Complex | `gpt-6.1-sol`, high | `claude-opus-5-5`, high | `deepseek-flash`, max |

Antigravity uses the same ordered model and effort pairs for every difficulty.
The starting order is `gemini-4-hydrogen` at high, followed by `gemini-3.8-flash` at high.
A saved single pair is read as a list of one, and the owner can add, remove, and reorder pairs in Settings.

The brain's own starting values:

| Provider | Model | Effort |
| --- | --- | --- |
| Codex | `gpt-6.2-astra` | high |
| Claude Code | `claude-opus-5-5` | high |
| dsh | `deepseek-flash` | high |

An explicit model and effort the chosen machine's program does not offer is refused.
For automatic Antigravity starts, the hub tries the ordered pairs that an eligible machine offers.

## Memory

Memory is shared across every topic.
It belongs to the owner.

- Each memory is one text, in Chinese, stored exactly as the owner wrote or confirmed it.
  The page shows it as it is, line breaks included, and the brain is given exactly that text.
- The owner adds, edits and deletes memories in 记忆, with no limit and no refusal: whatever the owner saves is what is stored.
  Only a blank box is not saved.
- The brain only suggests.
  Its `remember` creates a suggestion, which may name the memories it replaces; its `forget` suggests removing one.
  Suggestions wait in 记忆's 待确认 until the owner presses 确认 or 不要, and the navigation shows how many wait.
  Nothing else waits on them, so they are not notices.
- The hub refuses a suggestion whose text is the same as a memory, as a suggestion still waiting, as one the owner declined, or as a memory the owner deleted.
  "The same" ignores white space, punctuation of either width, letter case and invisible characters.
  Two wordings of one meaning are left to the brain's judgement.
- The hub also refuses a suggestion without Chinese or one that looks like a credential.
  The brain's suggestions have no count or length limit.
- The seed includes confirmed memory.
  Each topic gets changes to confirmed memory at its next input.
  The shared memory tools give access to the complete confirmed text, suggestions waiting and what the owner declined or deleted.

## Deployment

A deployment is done by a worker, through a task ticket, as the owner would tell Codex or Claude Code at the machine to deploy the project.
A repository declares its deployment in `.superagent2/deployment.json`: the machine it runs on (`target`, a runner's name, never the hub's container or the NAS host), the folder, and the deploy, health and rollback commands.
It is the worker's recipe.
The hub reads it when the ticket is opened and runs the ticket only on that machine; the runner refuses to deploy where the file at the deployed commit does not point.

When the brain files work that will need deploying, it arranges the deployment's task ticket after the chain at filing time, so the owner's one 开始 starts both; the deployment begins by itself when the chain has merged, at the chain's final merge commit.
The worker deploys, checks health, rolls back when the new version does not come up, and reports.
Done, the merged tickets it contains are marked deployed and what waits for that deployment begins; failed, it is a failed ticket like any other.

Super Agent deploys itself the same way: its file names a machine of the owner's that can sign in to the NAS, whose worker runs `deploy/deploy.sh release` there.
The hub and the brain restart underneath the ticket; the worker goes on, its hand-back reaches the new hub, and the runner then moves to the new hub's version.

## Worker silence

The hub tells the brain privately in the ticket's topic when a running worker on a connected machine goes quiet for `HUB_WORKER_SILENCE_MINUTES`, which defaults to 20 minutes.
The notice includes the last work event and the end of the worker's text, and repeats at each doubling of the threshold until another work event arrives.
The hub measures from the later of the last event's receipt and the machine's latest connection, so time spent disconnected or restarting the hub does not produce an immediate notice.
The same check covers code tickets, task tickets and light tasks, and skips workers waiting for an answer to a question.
The notice leaves the ticket and the worker running, and the brain can use `read_ticket` to see when the hub last received an event.

## Follow-ups after merge

For an owner's adjustment to merged code, the brain uses `follow_up_ticket` to comment on an original issue, reopen it if needed, and file a pending ticket in the current topic.
The owner starts the ticket on its card, which prefers the most recent worker's machine and engine when available.
The runner recreates the original worktree path on that machine, prepares the new branch from the current default branch, and gives the resumed session the new comment and the default branch's recent commits.
When the session is unavailable, a new worker receives the comment, the original issue, the earlier pull requests and the recorded work it needs to take over.
Each follow-up uses the normal verification and merge rules, and the merge report says whether the session was resumed or a worker took over.
Only one follow-up to the same original work can be open at a time because follow-ups reuse a worktree path.

## Verification rules

Each pull request a worker hands in is verified on its own.
The level is computed from its changed files, not judged by an LLM.

| Change | Rule |
| --- | --- |
| Text and documentation files only | None. Merge. |
| Anything else, with Woodpecker configured | Apply the Woodpecker workflow rule on the pull request's head. |
| Anything else, with Woodpecker unset | Run the repository's declared check on the pull request's head. Merge when the check is green or when the head declares no check. |

The worker's own test run is part of the work, not a verification stage.
The brain can skip the CI rules when the owner wants that.

Without Woodpecker, the hub reads `.superagent2/check.json` from the exact pull request head and expects a JSON object with a single `command` field containing one line of at most 4096 characters.
An absent declaration produces a direct merge with the rule recorded on the ticket.
The runner executes declared checks for the ticket's own branch in the repository, using a clean detached checkout and the same operating-system shell as a local brain.
It uses a temporary profile and an allowlist of runtime variables for the command.
Fetching a missing commit can use the runner's own Git sign-in, and the hub sends no GitHub credential with a check request.
The hub prefers the ticket's worker machine, then tries available runners with the repository.
The hub keeps one assignment per repository across reconnects and restarts, and releases it on completion or when the runner reports that it cannot run the check.
A runner's absence or loss of available slots leaves the check waiting.
The hub sends a notice after the first-time allowance if an assigned check is still pending.
A nonzero command exit or invalid declaration enters the guided failure loop as a repository check failure.
The runner writes the full output to the ticket's artifacts, and the brain receives its last lines on failure.
The ticket page shows the rule that applied.
Setting only one of the two Woodpecker settings leaves code verification waiting for a complete configuration.
This repository declares `corepack pnpm verify:checkout`, which installs its locked dependencies and browser and then runs `pnpm check`.

The hub reads the optional `.superagent2/ui.json` at the pull request's head and matches its `paths` globs against changed files, including the old name of a renamed file.
A match requires screenshot files for the same head with an after image at both the phone and desktop widths and a paired before image wherever the view already existed.
The worker identifies a new view in the hand-in.
The runner sends the images over the task-file transfer channel and the hub keeps them with their pull request.
The hub returns an incomplete UI hand-in to the same worker and pull request without counting a guided round.
Once the screenshots are present, the usual CI rule applies.
The topic's merge report and the ticket page show the screenshots by pull request, view and width, with each before image beside its after image.

Nothing in verification is decided from time, and a pipeline that never reports leaves the ticket verifying.
The hub does not leave it unnoticed: it records how long each repository's pipelines took when they ended green (Woodpecker's own creation and finish times, so waiting for an agent counts) and takes the median of the 15 most recent as the usual.
When a ticket's pipeline for its head, or the wait for one to appear, reaches three times the usual, the hub tells the brain with what Woodpecker says at that moment, and again at each doubling of the wait.
A repository with fewer than three green runs uses a first-time allowance instead, `HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES`, 120 by default.
The brain looks without interrupting and steps in only when the look finds a real problem.
The notice changes no state: nothing fails, no round is counted, nothing is cancelled.

## Code constraints

This is the complete list.

1. **Confirmation of irreversible operations.**
   Before running any command, the hub matches it against a list.
   A match is held until the owner confirms it on the web page, in the owner's own authenticated session.
   The brain cannot confirm on the owner's behalf.
   Initial list:
   - delete a repository, or make one public
   - force-push to, or rewrite the history of, a default branch
   - delete a database or a data volume on the NAS
   - delete files outside project folders

   The list matches known forms.
   It cannot see inside a script, so that part rests on the LLM's own judgement.
   Credentials are not on the list: changing or deleting one is not held.
   A credential file is a file like any other, so deleting one outside project folders is held by the rule above and nothing else about it is.
2. **Retry cap.**
   After three guided rounds on one ticket without passing, the hub stops the ticket and notifies the owner.
   Merge conflicts, returned UI hand-ins and unavailable programs do not count as failures or guided rounds.
   A merged pull request is progress: the count starts again for the next one.
   Only the owner answers the stop: resume with a fresh count, or give up, which opens a repair ticket that waits for the owner's start (see [Repair tickets](#repair-tickets)).
3. **Verification rules** before an automatic merge.
4. **Zero comments**, checked in CI across the whole repository.
5. **Start by the owner.**
   A chain starts from 开始 in the owner's authenticated session or from a confirmed schedule's authorized run.
   The hub verifies that a run consumed its own scheduled input and starts only tickets that the hub recorded for that run.
6. **No reach into the NAS host or the work machines.**
   The brain's commands run only in the hub's container.
   The hub has no target on the NAS host, mounts nothing of it but its own folders, and holds no key to sign in to it; a runner runs no command the hub sends, only the workers of tickets the owner started.
7. **Nothing without the front door.**
   No route of the hub is open to the internet: every request through the host name carries a signed Access assertion for the application that covers its path, and the hub refuses any request without one.
   There is no Bypass rule; adding a machine needs none, because its credentials travel in the install line.
8. **Ticket lock.**
   The owner explicitly required the hub to allow only one topic turn to change a ticket at a time.
   The hub enforces this on all brain-initiated changes to its ticket state, with a stale-read check and release at the end of the turn (see [Ticket changes](#ticket-changes)).
   The owner's controls and the hub's own work continue independently, and their changes advance the ticket version.
9. **One sentence per line in Markdown prose.**
   The owner explicitly required this rule, checked in CI.
10. **An exact allowlist for the app gateway.**
    The owner explicitly required Teams to stay read-only and mail writes to be limited to drafts requested by the owner.
    The hub checks each exact connector tool name against the allowlist in code and intersects it with the discovered tools.
    Sending, directly replying, forwarding and deleting mail are outside the allowlist.
    The gateway's only writes are saving and revising drafts and creating and undoing TickTick to-dos.
    This rule covers the app gateway and its brain tools.
    The brain's shell in the hub container can access the shared ChatGPT login and could start a separate app server, so this rule does not constrain arbitrary shell commands.

## Personal app gateway

The hub uses the owner's ChatGPT connections to read Outlook, Gmail, Microsoft Teams and TickTick on request.
One long-lived Codex app server calls the `codex_apps` MCP server directly on a read-only, ephemeral thread with plugins off and approvals disabled.
No model turn runs in the app server.
Calls have timeouts, and the gateway keeps its thread through timeouts and connector refusals.
It replaces a thread when Codex reports it missing or the app server process exits.
An initialization timeout stops the process because the gateway cannot tell whether the server created a thread.

The gateway reads the connector inventory at hub startup and every five minutes.
It discovers each Outlook account's link from the inventory and offers Gmail as one implicit mailbox.
设置 → 连接 shows the gateway status and discovered mailboxes, Teams and TickTick.
The brain can list or search mail by mailbox, read a message in pages with attachment names, list or search Teams chats and channels, and look up TickTick lists and tasks.
Only active Claude and Codex turns can list or call these brain tools.
The Codex brain uses the hub's tools for these apps with Codex's native apps disabled on its threads.
The brain treats app content as untrusted data.
The hub does not record tool arguments, raw results or connector error text in the topic history or hub logs.

Write tools require an active turn that consumed a visible owner message and is outside a scheduled run.
The brain sets the owner-request flag only for a draft, to-do, reminder or undo the owner requested in that message.
The hub checks the turn and the flag without interpreting the owner's prose.
`mail_draft` can save new messages and threaded replies in the selected linked Outlook or Gmail mailbox.
The Gmail connector also supports updating an existing draft.
A Gmail draft update that replaces the body replaces its MIME parts, including attachments.

`add_todo` sends the task to a named open TickTick list or uses TickTick's configured creation list with inbox as its fallback.
Dates are all-day tasks and local times use the same hub time zone as schedules.
An explicitly requested timed reminder gets a TickTick notification at the due time.
The hub saves a receipt with the connection and task IDs and the list ID when known.
`undo_created` can delete only a task with a receipt that identifies its list on the current connection.
An undo without a receipt ID selects the latest creation in that topic.
The gateway never replays a delivered write when the app server exits or the answer times out.

### Mail intake and triage

The built-in mail job reads linked Outlook and Gmail mailboxes every five minutes.
It begins with the five minutes before the first poll, overlaps later successful windows and deduplicates by mailbox and message ID.
It skips sent mail and drafts by connector filters and known owner addresses.
Each mailbox advances independently, so a slow connector can leave other mailboxes reading.

A timeout narrows that mailbox's next time slice down to one minute.
After three timeouts on the same minute, the hub checks the following minute before it skips anything.
When the following minute reads successfully, the hub moves past the bad minute and posts the mailbox and skipped time range in 邮件.
A mailbox without progress for one hour gets one stalled notice during that incident.
设置 → 连接 shows each mailbox's intake status.

Before brain review, a Codex-only filter examines batches of up to 20 envelopes and the owner's confirmed memory in an ephemeral, read-only session with apps and tools disabled.
It keeps clear requests for action or decisions, real deadlines or risks, changes to the owner's own memberships and subscriptions, shipping and delivery updates for the owner's orders, and messages covered by a memory keep rule; uncertain mail is ignored.
It ignores GitHub CI notices, expiring loyalty points, stars and rewards, promotional upsells, one-time codes, receipts, order and payment confirmations, daily card activity summaries, meeting logistics, project status or file-sharing FYIs without a request, and platform engagement prompts unless confirmed memory keeps them.
Security alerts, password resets, bills with a due date and direct requests from real people beyond meeting logistics remain eligible for review.
Membership changes and shipping updates use the kinds `membership-change` and `shipping-update` respectively.
Kept messages with the same sender address and kind in one batch are merged deterministically into the newest representative, with a count and received-time range for review.
Merged envelopes are marked checked and cleared like ignored mail, and the representative retains its group information through review retries.
Ignored envelopes are marked checked and their sender, subject and snippet are cleared.
A failed or invalid filter answer leaves the batch queued with exponential backoff capped at one hour, and never sends it unfiltered to the brain.
After three failures the hub posts one notice in 邮件 without a push, followed by one recovery notice when filtering succeeds.

The historical dry run uses the same filter against connected mailboxes without a hub database, cursor changes, notices or brain turns.
It reports each decision, its representative when merged, group counts and per-mailbox merge totals for owner review before deployment.
See `docs/deploy.md` for the checkout and container commands.

The mail job uses dedicated hidden brain turns because service-triggered schedules show their input and post a completion notice for silent runs.
New mail waits for a Claude or Codex brain that supports mail review.
These turns use an isolated session, the owner's memory, and untrusted JSON containing the message IDs, senders, subjects and snippets.
Their hub tools are limited to reading messages in the current batch and reporting its triage result.
The brain reads bodies only for mail that may need attention.
The hub keeps unfinished mail queued for retry and clears the private prompt when that review attempt ends.

An actionable result goes to the 日常 topic 邮件 with the sender, subject, requested action, any deadline and whether a reply is worthwhile.
Routine mail produces no notice.
The hub batches ordinary summaries at most once every 30 minutes, with a separate immediate path for mail the brain marks time-critical.
Each published summary sends one generic push with the number of actionable messages and a link to 邮件.
The lock-screen push contains no sender, subject or message content.
When the owner follows up on a summary, the brain can locate the message by its mailbox, sender and subject.

## Tests

No test fails because something took longer than expected.

- No test asserts how long something took, and no test has a time limit of its own.
  The test runner's per-test timeout is off; only the pipeline's overall limit ends a run that hangs.
- Logic that depends on time is tested with a clock the test controls.
- A test waits for an event, never for a duration.

## Attachments

The owner can attach any file to a message in the main stream, a topic view or a ticket's messages to its worker.
Files can come from the photo library, the camera or Files on the phone, from a pasted image or from a drop on the composer on a computer.
A message may be attachments alone.

- The page uploads each file as soon as it is chosen, in parts of 8 MiB, each one request; the hub writes each part straight to disk and never holds the file in memory or in SQLite.
  A part that fails is sent again from where the hub stopped, so a long video from a phone needs no new start and the message waits in the composer until its files are in.
- The hub keeps every attachment in a folder of its own named by a random id, under a name made safe for any file system from the one the owner's device gave.
  On the NAS that store is the `superagent2-brain-link` volume, which the brain's container reads at the same place, so the brain is told only the file's path inside it.
- The brain's program is told each file's type, size, attachment id and path under the owner's message, and is given the images as images where its program takes them (Claude Code, Codex and dsh).
  It reads other files with its own tools.
  It hands a file on to a worker by its attachment id, as material of a task ticket or with a message.
- A file sent to a worker travels to its machine over the runner's link, in parts the runner asks for, and lands in the ticket's folder outside the worktree, so it is never committed by accident.
  A message for a worker whose machine is away is kept by the hub and given again whenever the machine comes back, until the worker has it.
- A download is always a download: served as an attachment, with `nosniff` and a sandbox, and an image is shown as an image only for the types every browser and program read as images.
- Nothing is pruned.

## Device transfer

The transfer tab is a private store independent of topics.
Entries retain their exact text and files until deleted.
Files are uploaded in parts to the hub's private data volume, outside the brain's mounts.
Device and MCP uploads allow 100 MiB per file and 30 files per entry.
Desktop agents use the stateless Streamable HTTP MCP endpoint at `/inbox/mcp`, with the inbox Access assertion and an active inbox source for every request.
OAuth clients such as ChatGPT and Claude web use `/mcp` for the same tools and share the `OAuth MCP` source label, idempotency keys and limits.
Each successful send creates one entry labelled with its source name and stores an optional note of up to 2,000 characters.
`send_files` accepts up to 1 MiB of file data inline, while `begin_upload`, `upload_part` and `finish_upload` accept parts of up to 8 MiB before base64 encoding.
The hub records each send by source and idempotency key and limits each source to 60 new sends per minute and two pending multipart uploads.
Incomplete MCP uploads expire after 24 hours without progress and are cleaned up when a send starts.
Completing an MCP transfer sends a push that names the source and files and opens the transfer tab, without writing a topic message, entering routing or starting a brain turn.
File results from light tasks use the same transfer store and the runner's existing part-by-part delivery limits.
The transfer file and the conversation download share the stored bytes.
Deleting the transfer entry removes the transfer downloads and leaves the conversation download available.
Incomplete device uploads remain on disk until they are finished.
Entries are paged and changes refresh open pages over the owner WebSocket.
When the owner mentions a specific transferred file in the current message, the brain can use `transfer_lookup` to find file metadata and `transfer_read` to copy the requested file into its shared attachment area.
Both tools require an active owner turn and `owner_requested: true`, and a lookup can include device uploads as well as inbox and light-task results.

## Limits

Nothing the owner, the brain or a worker sends has an upper limit of its own: not a message, a task, material, a reason, a command, a list, or the number and size of a task worker's files.
What remains is physical.
One request body or live message is at most 64 MiB, and a request past it is refused with a plain statement that this is the system's physical limit.
A task worker's text result too long for one message reaches the owner whole, as a file.
Delivered files go from the runner to the hub in parts the hub asks for, and are kept as files beside the hub's database.
The owner's attachments go to the hub in parts the page sends, and from the hub to a runner in parts the runner asks for.
Clipping of logs and output handed to an LLM, or listed on the page, is not a limit: the full text stays.

The brain keeps at most `BRAIN_MAX_OPEN` topic programs open at once, four by default.

The [session seed](#session-seed) uses `BRAIN_SEED_SOFT_SHARE`, 0.15 by default, as the soft share of the input capacity of the provider and model running the session.
It scales with that capacity and is not a hard cut.
The seed includes confirmed memory, open tickets and the topic board in full by default; there are no fixed token totals or per-part token shares.
Once the soft line is passed, the hub starts leaving material out in this order: topic-board statuses (keeping titles), the oldest of the last 50 history turns (always keeping the summary), ticket lines beyond this topic's own, then confirmed memory.
Each omission states its count and the hub tool that reads the omitted material.
The quoted message and current input keep priority over everything else.
If the quote, current input and recent turns alone exceed the soft line, keep them while they fit; drop older turns only as needed to stay within the provider's hard input capacity.
That capacity is the only hard limit.
Omitted items remain available through the hub tools.

## Worker storage

Each machine has a projects folder and an artifacts folder in Settings → Machines.
The hub saves the owner's paths and sends them before dispatching work on each new runner connection and again when the owner saves a change.
The runner checks paths on its own platform and reports the folders in use and the availability of shared storage.
Cleared settings let the corresponding `runner.env` values take effect.

Within a projects folder, the runner reuses a first-level checkout whose `origin` names the repository, regardless of the checkout's folder name or remote URL form.
When no origin matches, it reuses a Git checkout whose first-level folder name matches the repository name without regard to case.
It makes one checkout under the repository name when neither match is present.
Code tickets get separate branches and worktrees at `_agent/<checkout folder>/t<ticket>`.
Tasks with a repository get a detached worktree, and tasks without one get `_agent/_tasks/t<ticket>`.
Preparation is serialized per repository.
The runner fetches into Git refs and works in the ticket's own worktree.
The owner's branch, index, files, and repository config stay intact.
Git identity and credentials are scoped to the worker session.

The worker's brief and `SUPERAGENT2_ARTIFACTS_DIR` identify the directory for build outputs, test reports, and other large generated files.
It is `<artifacts folder>/<repository name>/tickets/t<ticket>`, with `_tasks` for tasks without a repository.
A missing or unwritable shared folder falls back to `artifacts` under the runner's state directory and is recorded in the ticket.
A later session checks the shared folder again.
Ticket cleanup removes its worktree and keeps its artifacts.
Task hand-back files continue to use the task's delivery folder.

## Decisions

A choice that would have been the owner's, made without the owner so that work does not stop, is recorded in [decisions.md](decisions.md): what was chosen, why, and what the other options were.

## Language

Everything written is English: code, issues, pull requests, commits, documents, and what workers are told.

Everything the software shows the owner is Chinese, and only Chinese.
Proper nouns and technical terms may stay as they are.

- The interface's own text comes from one Chinese catalog.
- The page's markup holds no literal text: every label comes from the catalog, and `pnpm check` fails otherwise.
- Text an LLM generates for the owner to see is kept twice: the English original, which goes to GitHub and to other LLMs, and a Chinese copy written at the same time by whoever generated it.
  That covers a ticket's title and summary, a worker's report, the brain's guidance, the reason a ticket stopped, and notices.
  The page shows the Chinese copy.
- The memory is the one exception: it is the owner's own text, kept once, in Chinese, and given to the brain as it is.
- The brain converses with the owner in Chinese.
- Raw material is shown as it is: command output, logs, code and diffs.

## Notices

- Regular ticket events, including merges, failures, stops, deliveries and deployments, go straight to the ticket's topic and appear in that topic's stream.
  An older ticket without a topic first inherits one from its repair lineage or a predecessor it waits for.
  If neither provides a topic, the first event creates one named after the ticket.
- Hub notices without a ticket, such as new-model notices, go to a shared System topic created on first use in 日常.
  New-model notices link to Settings → Models and tell the brain the reported efforts, machines and current row.
- Machine and provider problem notices appear in both the 日常 System topic and a separate repository-free 代码 System topic.
  An incident sends one push when it starts and one notice in each topic when it recovers, without starting a brain turn.
  Incident state and both notices are stored together so a hub restart does not repeat them.
  A disconnected machine and a persistently overloaded service have a ten-minute grace period; program probe failures and other provider problems are reported immediately.
  If the hub starts with no recorded disconnect for an offline machine, it starts that machine’s grace period then because the last report is not a heartbeat.
  Used-up allowances, rate limits, balances, and program updates do not cause notices.
  Provider events carry a category when known; older events without one use their reason text for compatibility.

What waits for the owner (a held operation, a stopped ticket, a question, a chain to start) shows in 工作台's 等你 and is sent as a push notification from the web page.
There is no Lark channel.
The notification for a held operation names where it runs and the command, cut visibly when it is too long for a push message, and never its environment.
The brain's memory suggestions wait in 记忆, not in 等你, and send no notification.
An inbox message sends a push with the source and the beginning of its text, opening that source's 日常 topic.
An inbox file send opens 传输 and includes the file names within the push payload budget.

## Interface

The look and layout follow the prototype in [ui/prototype/](ui/prototype/), copied from the first Super-agent with its comments removed.
It specifies look and layout, not behaviour.
The finish is the owner-approved skeuomorphic material in `packages/web/src/styles/material.css`, specified in [ui/skeuomorphic-spec.md](ui/skeuomorphic-spec.md) with the geometry it must reproduce in [ui/skeuomorphic-measurements.txt](ui/skeuomorphic-measurements.txt).

A brain turn that opens or arranges work waiting for the owner shows a compact start card in its own topic.
The card retains the arrangement fingerprint from that turn and uses the live start choices and the same owner start route as 工作台.
A changed arrangement cannot be started from its older card.

Kept from it:

- warm graphite grounds, in light and dark
- one accent colour, for primary actions, the current item and counts that ask for attention
- state dots in fixed hues that never take the accent colour
- a sidebar on wide screens and a tab bar on phones
- the navigation: 工作台, 对话, 历史, 记忆, 定时, with 设置 last
- start cards in 工作台: what can start now, and what comes after it

Changed by this design:

- 定时 uses a canvas of cards with a 待确认 group and persistent cards for active, paused and completed schedules.
  The tab counts pending proposals, and each proposal links to its source topic and shows the changes when it proposes an edit.
  Confirmed cards show the recurrence, next run or triggering service, and latest outcome.
  The owner can create, edit, pause, resume and delete schedules on the canvas.
  The run history links to topic messages and visible tickets, and the workbench marks tickets that came from schedules.
- 对话 keeps a switch at the top, 代码 | 日常 | 传输.
  代码 shows all repository topics or the topics in one selected repository.
  日常 shows daily topics, including System.
  传输 is a private store for device transfers, desktop-agent file sends and light-task file results.
  Each inbox source has a 日常 topic created on first use and restored when a message arrives after archival.
  Its messages are labelled with the source, available in topic history, and never start a brain turn or enter routing.
  Each brain answer and each owner message has a small topic label that opens the topic view.
  The label also shows the repository when reading all of 代码.
- 对话 opens in 代码 at the root and at the unqualified conversation list.
  日常, repository selections and all of 代码 have shareable addresses.
  The repository chooser uses repositories the hub knows from tickets and topics.
- The topic list shows automatically recognised topics.
  Selecting a topic filters the view and sends input directly there.
  Topics can be renamed, merged or archived from the list or the topic view.
- 工作台 shows repositories on the left, the selected repository's chains in the centre and its conversation on the right.
  Visible task tickets appear with the repository they concern, including operations in scratch.
  The conversation panel uses the same stream, topic list and composer scoped to that repository.
  全部 uses the combined code stream, and 日常 uses the daily stream.
  A selected ticket replaces the conversation in the panel; a pending ticket opens its start controls in a dialog.
  On phones, tabs switch between canvas and panel.
  The canvas groups connected tickets by their dependencies and recomputes a snake layout and arrows on resize.
  The phase bar maps waiting to 等待, working to 执行, verifying to 验证, and merged to 合并.
  Started tickets waiting for predecessors remain in their chain and show their queue; cross-repository predecessors are references in a repository view and full cards in 全部.
  Daily tickets are listed in one column.
- The owner can quote a message when replying, as in Teams.
  The composer shows the quoted message.
  Picking a destination under 移到… moves an owner message immediately.
  A possible match from routing can be used in one tap.
- Held irreversible operations appear as confirmation cards in 工作台's 等你.
  That is the only place they can be confirmed.
  确认 and 拒绝 each take one press.
- A ticket shows which verification rule applied and which guided round it is on.
- A ticket shows the decisions made on the owner's behalf above its timeline, each with 可以 and a box for an opinion.
- 继续 and 放弃 on a stuck ticket's card each take one press.
  A repair ticket carries a 补救 chip on its card, its row and its page, and its page links to the ticket it repairs; the repaired ticket links to its repair.
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

Third-party credentials are reused from the first Super-agent's deployment.
No code is taken from there.
Values are copied on the NAS from the old secrets folder into the new deployment's secrets folder at deploy time; they never enter this repository, and `.gitignore` excludes the file types that hold them.

| Credential | Where it lives today | Used for |
| --- | --- | --- |
| `GITHUB_TOKEN_NOVAN_XU`, `GITHUB_TOKEN_NUOFAN_ISLAND` | NAS, `secrets/github.env` | Every GitHub operation |
| `ACCESS_TEAM`, `ACCESS_AUD`, `OWNER_EMAIL` | NAS, `secrets/hub.env` | Checking the front door's sign-in |
| `ACCESS_RUNNER_AUD` | NAS, `secrets/hub.env` | Checking the runner application's assertion on `/runner/` |
| `ACCESS_INBOX_AUD` | NAS, `secrets/hub.env` | Checking the inbox application's assertion on `/inbox/` |
| `ACCESS_MCP_AUD` | NAS, `secrets/hub.env` | Enabling `/mcp` and checking the OAuth MCP application's assertion on that path |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_API_TOKEN` | NAS, `secrets/hub.env` | Creating and deleting runners' Access service tokens (Access: Service Tokens, Edit, nothing else) |
| Cloudflare API token, `TUNNEL_TOKEN` | NAS, `secrets/cloudflare.env`, `secrets/tunnel.env` | The host name and its tunnel |
| `WOODPECKER_SERVER`, `WOODPECKER_TOKEN` | NAS, hub environment | Reading CI results and logs |
| The ChatGPT login for Codex | NAS, volume `superagent2-brain-codex`, mounted by the brain and hub | The brain on GPT and the personal app gateway |
| `BRAIN_CLAUDE_OAUTH_TOKEN` | NAS, `secrets/brain.env` | The brain on Claude |
| The DeepSeek account login for `dsh` | On the runners; made once in the brain container | The brain on DeepSeek |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | NAS, `secrets/hub.env` | Push notifications |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `RUNNER_TOKEN` | Each runner, `~/.superagent2/runner.env`, readable only by its user | A runner passing the front door and proving which machine it is |

Credentials internal to the system (the brain-to-hub token, each runner's token) are generated fresh.
A machine's service token and runner token are made when 添加机器 is pressed and shown once, in the install line; the hub keeps only the service token's ids and the SHA-256 of the runner token, and service tokens it makes do not expire.
The hub holds no credential for the NAS host itself.
Workers use the logins of the command-line programs already present on each runner.

The confirmation lock does not guard credentials.
Changing or deleting one, a secret, a key, a token, a grant or a login, runs without confirmation; a credential file is deleted under the same rule as any file.
The hub still refuses credential-looking text in a memory, and still injects the credentials into each command itself.

## Build order

The work is tracked as GitHub issues under five milestones.

1. **Brain reach.**
   Hub with the general command channel, the front door and the confirmation lock, with the brain connected to it and a Chinese conversation page.
   Then deployment on the NAS, taking over the host name and stopping the first Super-agent.
2. **Dispatch.**
   Runners, tickets and chains, start defaults, and workers through to an opened pull request; writing tickets; 工作台.
3. **Verification and merge.**
   Woodpecker and runner verification rules, automatic merge, the failure loop and its retry cap.
4. **Deployment.**
   Deployment by the brain with health check and rollback, Super Agent itself included.
5. **Interface completion.**
   历史, 记忆 and 设置.

The runner checks worker programs at startup and every six hours.
The brain can call `recheck_machines` for one machine or all registered machines to request a fresh probe and allowance reading without restarting the runner.
Runners get Antigravity's Gemini Models weekly and five-hour quota from the CLI's read-only `/usage` command.
The allowance panel shows the newest current reading after Claude and before DeepSeek.
The Gemini Models reading is informational and the hub uses worker-reported limits for Antigravity routing.
The tool waits up to 30 seconds for a correlated report and identifies offline machines and timeouts.
A request during a program update waits for the update lock, and a recheck neither interrupts workers nor starts an update.
For an npm global installation whose resolved executable belongs to the expected package, it compares the installed version with npm's stable `latest` and updates while the machine is idle.
It reserves the machine during the check and installation, queues assignments that arrive meanwhile, and immediately probes and reports the programs again after an attempted installation.
A backup of the package and executable is restored if npm fails.
The runner also recognises custom npm prefixes, Claude Code native installations, and the Antigravity CLI installed in its standard location.
It invokes the vendor updater for the latter two, verifies that the resulting version is stable and does not downgrade, and restores the launcher on failure.
The vendor updater is checked while idle even when no new version is available.
Installations without a verified safe updater are reported; in particular, the dsh command bundled with DeepSeek Harness Desktop must be updated through that application.
Set `SUPERAGENT2_PROGRAM_AUTO_UPDATE=0` in the runner's environment to disable these checks on a machine.

Runners read the DeepSeek balance through dsh’s own account service, without copying its login.
The hub marks a balance below `HUB_DEEPSEEK_LOW_BALANCE` as low; the default is 30 in each currency.
A failed read is unknown and does not clear a previously empty balance.

Office previews are generated on demand by an isolated Gotenberg converter.
The hub caches PDFs by SHA-256 in its data directory, shares concurrent conversions, and serves the result as an inert download.
The viewer renders that PDF and retains the original download.
Conversion requests and results are limited to 64 MiB, and requests time out after 90 seconds.

## Extra MCP servers

The hub can offer additional HTTP MCP servers to the brain, workers, or both.
It reads definitions and named token variables from its environment, sends selected endpoints over its authenticated brain and runner links, and keeps tokens out of program arguments.
Claude Code receives environment references in its strict MCP configuration, and Codex receives bearer token environment variable names.
The dsh adapter uses its HTTP MCP client.
Antigravity loads extra servers from a temporary configuration directory passed with `--add-dir`.
The configuration starts a stdio bridge that authenticates to the HTTP MCP server with the token from its environment.
The per-session permissions allow calls to the configured MCP servers, and the adapter removes the temporary directory when it closes.

The allowance panel includes OpenAI API month-to-date costs within GPT when the hub has an `OPENAI_ADMIN_KEY`.
The hub polls organization costs every 15 minutes using the ticket time zone for the month boundary and retains the last successful reading when a request fails.
An optional USD monthly budget can be set or cleared in usage settings; it is informational and does not restrict API calls.

Pinned workbench repositories are automatically unpinned after 24 hours without an open ticket, a ticket state change or merge, a topic message, or an owner pin.
Existing pins receive 24 hours from the migration, and automatically unpinned repositories remain available in the catalog and topic routing.
