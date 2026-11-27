# Development standard

## Principles

1. A rule that must hold is enforced by code, not by a document.
2. Verification is static and deterministic, and no LLM reviews the work of another LLM.
3. Documents are written one sentence per line.
4. Code holds no comments.
5. A new enforced rule is added only when the same failure has happened twice, or when the owner explicitly requires it.

## AGENTS.md

- Keep it short.
- Link to the documents that hold the details instead of repeating them.
- Write it as advice, in words such as "prefer", "suggested" and "one reasonable way".
- Do not rely on it for anything that must hold; every such rule is a check in the repository.
- Name the one command that checks the repository, and link to the design and decision records.

## The check command

- Every repository has one command that runs every check, for example `pnpm check`, `make check` or `just check`.
- It runs the type or static checks, the tests, the build, the zero-comment check, the sentence-per-line check, and any other static check the project needs.
- The same command runs locally and in CI.
- Run it before opening a pull request.
- It exits with a non-zero code when anything fails, and names the file and line where it can.

## UI changes

Declare the repository-relative UI path patterns in `.superagent2/ui.json` under `paths`.
Provide a headless screenshot command for named views at 390 × 844 and 1440 × 900, and run the browser layout check at both sizes in the check command.
Check that the page has no horizontal overflow and that key elements stay in the viewport.
For a matching pull request, hand in light-theme PNG or JPEG screenshots in the ticket's screenshot folder with a view name, a width of `phone` or `desktop`, and a phase of `before` or `after`.
Use the default branch for the before captures and the pushed pull request head for the after captures.
Include an after image at each width and pair each after image with its before image if that view already existed.
List new views in `newViews` in the hand-in.
Hand in at most 16 images of up to 2 MiB each.

### Super Agent browser commands

Run `pnpm install --frozen-lockfile` and `pnpm browser:install` to set up the browser checks locally.
The same install command runs on the macOS and Windows Woodpecker workers.
The lockfile verifies the Playwright packages, and the browser installer verifies the pinned Chrome Headless Shell archive with SHA-256 before extraction.
When updating Playwright, update the browser download version and checksums in `tools/page-dev/src/chromium.ts` to match the release.
Run `pnpm check` for all checks or run `pnpm layout` after `pnpm build` to rerun the browser checks alone.
The check opens the built page in the page development harness with sample data and checks horizontal overflow and key element bounds at 390 × 844 and 1440 × 900 in the light theme.
Long code blocks, tables and repository tabs may scroll inside their own bounded containers.

After `pnpm build`, use `pnpm screenshot --view transfer --width phone --out <dir>` to capture the transfer view with its HTML preview open.
The view names are `code`, `daily`, `workbench-canvas`, `workbench-conversation`, `ticket`, `transfer`, `settings`, `appearance`, `machines`, `models`, `repositories`, `memory`, `schedules`, `history`, `remote` and `remote-conversation`.
Omit `--width` to capture both widths, or use `--width desktop` for the desktop width alone.
The command writes PNGs named `<view>-<width>.png` to `--out`, then falls back to `SUPERAGENT2_ARTIFACTS_DIR` if set, or the current directory.
Use `--page-dir <built page dir>` with `pnpm layout` or `pnpm screenshot` to use a compatible build from another revision with the same sample data and viewport.
Use `--remote-fixture` with `pnpm screenshot` to show the remote-control entry in other views.
Use `--minimal-integrations` with `pnpm screenshot` to capture the sample views with optional integrations off and one signed-in worker provider.

## Verification and merge

- Whether a pull request merges is decided by its files and its CI results, not by an LLM reading it.
- A pull request that changes only text and documentation files may merge without waiting for CI.
- Text and documentation files are those ending in `.md`, `.markdown`, `.rst`, `.adoc` or `.txt`, and files named `README`, `LICENSE`, `CHANGELOG` and the like without an extension.
- Build inputs such as `requirements*.txt` and `CMakeLists.txt`, and files such as `.mdx` and `.svg`, count as code.
- With Woodpecker configured, a code pull request follows the Woodpecker workflow rule on its head commit.
- Without Woodpecker, a code pull request uses the check declared at `.superagent2/check.json` on its head, or merges directly if the head has no declaration.
- Green means the newest pipeline for the head commit, with every workflow successful.
- Pending, running, cancelled or skipped is not green, and neither is a result on an older commit.
- A pull request whose CI has not reported waits; it is not failed because of time.
- A failure is never fixed by weakening a test, skipping a check or removing a workflow.
- Squash merge is preferred, so that each piece of work is one commit on the default branch.

## CI

- Workflows run on pull requests, on pushes to the default branch, and on manual start.
- One workflow runs per platform the code must run on.
- Tool chain versions are pinned in the repository, downloaded in the workflow, and checked against their published checksums.
- Dependencies are installed from the lock file only, for example with `--frozen-lockfile`.
- A PowerShell step checks `$LASTEXITCODE` after every program it calls, since PowerShell does not stop on a failing program by itself.

## Tests

- No test fails because something took longer than expected.
- No test asserts how long something took.
- No test has a time limit of its own; only the pipeline's overall limit ends a run that hangs.
- Logic that depends on time is tested with a clock the test controls.
- A test waits for an event, never for a duration.

## Code

- No comments, in any file the repository tracks, including configuration, scripts and Markdown.
- The zero-comment check enforces it across the whole repository.
- Types are strict where the language offers it.
- Data from outside the program is checked against its declared shape before it is used.
- Line endings are LF, set in `.gitattributes`.

## Documents

- Prose is written one sentence per line, and a sentence is never wrapped across lines.
- This keeps edits to different sentences on different lines, so they do not conflict at merge.
- A check in the check command enforces it.
- Everything written in the repository is in English.
- Design decisions are recorded in `docs/decisions.md`, newest last.
- Each record gives the date and a title, then what was chosen, why, and what the other options were.
- The enforced rules are listed in one place in the design document, as a closed list.
