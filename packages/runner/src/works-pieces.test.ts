import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workPaths } from "./workplace.js";
import { FakeHandle, repository, scratch, home, programs, git, start, task, events, ended, handBack } from "./testing/works.js";

describe("a worker on the runner", () => {
  it("hands in a pull request for part of the chain, and continues the next piece in the same folder on a new branch", async () => {
    const works = start();
    const ticketReference = "ai-2026-11-19";
    const branch = `sa2/${ticketReference}-abcd`;
    const nextBranch = `sa2/${ticketReference}-beef`;
    works.receive({ type: "work.start", task: task(9, { ticketReference, branch }) });
    let handle = await programs.prompted(1);
    expect(handle.prompts[0]).toContain(`You are working on ticket ${ticketReference}.`);
    const paths = workPaths(home, repository, 9);
    handle.emit({ type: "session", session: "thread-9" });
    writeFileSync(join(paths.worktree, "first.txt"), "first");
    await git(paths.worktree).must(["add", "first.txt"], paths.worktree);
    await git(paths.worktree).must(["commit", "-m", "First"], paths.worktree);
    writeFileSync(join(paths.clone, ".git", "info", "exclude"), "cache.txt\n");
    writeFileSync(join(paths.worktree, "cache.txt"), "kept");
    handBack(9, 50, [11], branch);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(9)).toMatchObject({ kind: "finished", pullRequest: 50, closes: [11] });
    const seed = join(scratch, "seed");
    await git(seed).must(["pull", "origin", "main"], seed);
    writeFileSync(join(seed, "first.txt"), "first");
    await git(seed).must(["add", "first.txt"], seed);
    await git(seed).must(["commit", "-m", "Squashed #50"], seed);
    await git(seed).must(["push", "origin", "main"], seed);
    works.receive({
      type: "work.start",
      task: task(9, { attempt: 2, ticketReference, branch: nextBranch, merged: [11], session: "thread-9", note: "Pull request #50 is merged into main. Still open: #12." }),
    });
    await programs.changed.until(() => programs.handles.length === 2);
    handle = await programs.prompted(1);
    expect(handle.options).toEqual({ session: "thread-9", tools: null, workspace: paths.worktree });
    expect(handle.prompts[0]).toContain(`Continue ticket ${ticketReference}. Pull request #50 is merged into main`);
    expect(events(9, 2).find((message) => message.event.kind === "phase" && message.event.phase === "prepared")?.event).toMatchObject({
      detail: `Switched the worktree ${paths.worktree} to the new branch ${nextBranch} from origin/main`,
    });
    expect((await git(paths.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], paths.worktree)).trim()).toBe(nextBranch);
    expect((await git(paths.worktree).must(["branch", "--list", branch], paths.worktree)).trim()).toBe("");
    expect((await git(paths.worktree).must(["log", "-1", "--format=%s"], paths.worktree)).trim()).toBe("Squashed #50");
    expect(readFileSync(join(paths.worktree, "cache.txt"), "utf8")).toBe("kept");
    handBack(9, 51, [11], nextBranch);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("closes none of the open issues of the chain (#12)");
    handBack(9, 51, [12], nextBranch);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(9, 2)).toMatchObject({ kind: "finished", pullRequest: 51, closes: [12] });
  });

  async function nextPiece(ticket: number, mainFirst: string, leave: (worktree: string) => void): Promise<{ readonly handle: FakeHandle; readonly worktree: string }> {
    const works = start();
    works.receive({ type: "work.start", task: task(ticket) });
    const first = await programs.prompted(1);
    const paths = workPaths(home, repository, ticket);
    first.emit({ type: "session", session: `thread-${ticket}` });
    writeFileSync(join(paths.worktree, "first.txt"), "first");
    await git(paths.worktree).must(["add", "first.txt"], paths.worktree);
    await git(paths.worktree).must(["commit", "-m", "First"], paths.worktree);
    leave(paths.worktree);
    handBack(ticket, 60, [11], `sa2/ticket-${ticket}-abcd`);
    first.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(ticket)).toMatchObject({ kind: "finished", pullRequest: 60 });
    const seed = join(scratch, "seed");
    await git(seed).must(["pull", "origin", "main"], seed);
    writeFileSync(join(seed, "first.txt"), mainFirst);
    await git(seed).must(["add", "first.txt"], seed);
    await git(seed).must(["commit", "-m", "Squashed #60"], seed);
    await git(seed).must(["push", "origin", "main"], seed);
    works.receive({ type: "work.start", task: task(ticket, { attempt: 2, branch: `sa2/ticket-${ticket}-beef`, merged: [11], session: `thread-${ticket}`, note: "Pull request #60 is merged into main." }) });
    await programs.changed.until(() => programs.handles.length === 2);
    return { handle: await programs.prompted(1), worktree: paths.worktree };
  }

  it("carries uncommitted work over to the next branch when it applies cleanly, keeps a copy, and tells the worker", async () => {
    const { handle, worktree } = await nextPiece(13, "first", (folder) => {
      writeFileSync(join(folder, "README.md"), "sandbox, next step");
      writeFileSync(join(folder, "notes.txt"), "started on #12");
    });
    expect((await git(worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim()).toBe("sa2/ticket-13-beef");
    expect((await git(worktree).must(["log", "-1", "--format=%s"], worktree)).trim()).toBe("Squashed #60");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("sandbox, next step");
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("started on #12");
    expect((await git(worktree).must(["status", "--porcelain"], worktree)).split("\n").filter((line) => line !== "").sort()).toEqual([" M README.md", "?? notes.txt"]);
    const kept = (await git(worktree).must(["show", "--stat", "--format=%s", "sa2/ticket-13-abcd-unfinished"], worktree)).trim();
    expect(kept).toContain("Work left uncommitted in the folder when it moved on from sa2/ticket-13-abcd");
    expect(kept).toContain("notes.txt");
    expect(handle.prompts[0]).toContain("Pull request #60 is merged into main.");
    expect(handle.prompts[0]).toContain("Uncommitted changes were found in your folder when it moved to the new branch sa2/ticket-13-beef. They were carried over");
    expect(handle.prompts[0]).toContain("a copy is kept on the local branch sa2/ticket-13-abcd-unfinished");
    expect(events(13, 2).find((message) => message.event.kind === "phase" && message.event.phase === "prepared")?.event).toMatchObject({
      detail: expect.stringContaining("carrying over the uncommitted changes found there") as unknown as string,
    });
  });

  it("keeps uncommitted work that does not apply on the updated default branch on a named branch, and tells the worker where", async () => {
    const { handle, worktree } = await nextPiece(14, "theirs", (folder) => {
      writeFileSync(join(folder, "first.txt"), "mine");
    });
    expect((await git(worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim()).toBe("sa2/ticket-14-beef");
    expect(readFileSync(join(worktree, "first.txt"), "utf8")).toBe("theirs");
    expect((await git(worktree).must(["status", "--porcelain"], worktree)).trim()).toBe("");
    expect((await git(worktree).must(["show", "sa2/ticket-14-abcd-unfinished:first.txt"], worktree)).trim()).toBe("mine");
    const commit = (await git(worktree).must(["rev-parse", "sa2/ticket-14-abcd-unfinished"], worktree)).trim();
    expect(handle.prompts[0]).toContain("They did not apply cleanly on the updated main, so sa2/ticket-14-beef starts clean");
    expect(handle.prompts[0]).toContain(`the local branch sa2/ticket-14-abcd-unfinished (commit ${commit})`);
    expect(handle.prompts[0]).toContain(`git cherry-pick --no-commit ${commit}`);
  });
});
