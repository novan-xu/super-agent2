import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workPaths } from "./workplace.js";
import { repository, home, programs, git, start, task, events, kinds, ended, handBack, finishTurn } from "./testing/works.js";

describe("a worker on the runner", () => {
  it("asks the worker to fix a missing or wrong hand-back, and hands back once it is right", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(6) });
    let handle = await programs.prompted(1);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("You have not handed in a pull request");
    expect(handle.prompts[1]).toContain("#11, #12 are still open");
    expect(events(6).find((message) => message.event.kind === "message")?.event).toMatchObject({ kind: "message", from: "hub", delivery: "steered" });
    handBack(6, 41, [99], "sa2/ticket-6-abcd", String.fromCharCode(0xfeff));
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("closes none of the open issues of the chain (#11, #12)");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(4, handle);
    expect(handle.prompts[3]).toContain("closes none of the open issues of the chain (#11, #12)");
    handBack(6, 41, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(6)).toMatchObject({ kind: "finished", pullRequest: 41, closes: [11, 12] });
  });

  it("hands back a bilingual code failure even when GitHub cannot be reached", async () => {
    let offline = false;
    const works = start({ readClosedIssues: async () => {
      if (offline) throw new Error("GitHub is unavailable");
      return [];
    } });
    works.receive({ type: "work.start", task: task(69) });
    const handle = await programs.prompted(1);
    const report = { en: "The package registry is unavailable.", zh: "软件包仓库无法访问。" };
    writeFileSync(workPaths(home, repository, 69).handback, JSON.stringify({ outcome: "failed", report }));
    offline = true;
    await finishTurn(works, handle);
    expect(events(69).at(-1)?.event).toEqual({ kind: "failed", failure: "no-pull-request", reason: report.en, report });
    expect(handle.prompts).toHaveLength(1);
    expect(handle.closed).toBe(true);
  });

  it.each([false, true])("fails after three idle code turns, with a commit during the first three turns: %s", async (commit) => {
    const works = start();
    works.receive({ type: "work.start", task: task(70) });
    const handle = await programs.prompted(1);
    await finishTurn(works, handle);
    await finishTurn(works, handle);
    expect(handle.prompts).toHaveLength(3);
    if (commit) {
      const cwd = handle.options.workspace;
      await git(cwd).must(["commit", "--allow-empty", "-m", "Advance the branch"], cwd);
      await finishTurn(works, handle);
      expect(handle.prompts).toHaveLength(4);
      await finishTurn(works, handle);
      await finishTurn(works, handle);
      expect(handle.prompts).toHaveLength(6);
    }
    await finishTurn(works, handle);
    expect(events(70).at(-1)?.event).toMatchObject({
      kind: "failed", failure: "no-pull-request", reason: expect.stringContaining("3 consecutive turns without progress. You have not handed in a pull request"),
    });
    expect(handle.prompts).toHaveLength(commit ? 6 : 3);
  });

  it("keeps the idle streak when the runner restarts the same attempt", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(71) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "session", session: "prior-session" });
    await finishTurn(works, handle);
    await finishTurn(works, handle);
    await works.close();

    const restarted = start();
    restarted.receive({ type: "work.start", task: task(71) });
    const resumed = await programs.prompted(1);
    expect(resumed.options.session).toBe("prior-session");
    await finishTurn(restarted, resumed);
    expect(events(71).at(-1)?.event).toMatchObject({ kind: "failed", failure: "no-pull-request" });
    expect(resumed.prompts).toHaveLength(1);
  });

  it.each(["owner", "brain"] as const)("resets the idle streak on a new message from the %s", async (from) => {
    const works = start();
    works.receive({ type: "work.start", task: task(72) });
    const handle = await programs.prompted(1);
    await finishTurn(works, handle);
    await finishTurn(works, handle);
    works.receive({ type: "work.message", ticket: 72, attempt: 1, id: "new-input", from, text: "Try again with the updated dependency." });
    await works.idle();
    expect(handle.steered).toEqual([`[Message from the ${from}] Try again with the updated dependency.`]);
    await finishTurn(works, handle);
    await finishTurn(works, handle);
    expect(handle.prompts).toHaveLength(5);
    await finishTurn(works, handle);
    expect(events(72).at(-1)?.event).toMatchObject({ kind: "failed", failure: "no-pull-request" });
    expect(handle.prompts).toHaveLength(5);
  });

  it("checks GitHub when resuming or repairing and marks the closed issues in each brief", async () => {
    const works = start({ readClosedIssues: async () => [11] });
    works.receive({ type: "work.start", task: task(65, { session: "prior-session", note: "Continue with the rest." }) });
    const resumed = await programs.prompted(1);
    expect(resumed.options.session).toBe("prior-session");
    expect(resumed.prompts[0]).toContain("#11 First issue (https://github.com/novan-xu/super-agent-sandbox/issues/11), closed on GitHub without a pull request of this chain; nothing to do");
    expect(resumed.prompts[0]).toContain("#12 Second issue (https://github.com/novan-xu/super-agent-sandbox/issues/12)\n");

    works.receive({ type: "work.start", task: task(66, { takeover: true, note: "This is a repair ticket." }) });
    await works.idle();
    const repair = programs.last();
    expect(repair.prompts[0]).toContain("This is a repair ticket.");
    expect(repair.prompts[0]).toContain("#11 First issue (https://github.com/novan-xu/super-agent-sandbox/issues/11), closed on GitHub without a pull request of this chain; nothing to do");
  });

  it.each([false, true])("settles when the last issue closes during a turn, with an explicit failure file: %s", async (explicitFailure) => {
    let dropped = false;
    const works = start({
      readClosedIssues: async (_context, numbers) => dropped ? [...numbers] : [],
      readBranchPull: async (_context, branch, issues) => {
        expect(branch).toBe("sa2/ticket-67-abcd");
        expect(issues).toEqual([12]);
        return null;
      },
    });
    works.receive({ type: "work.start", task: task(67, { merged: [11] }) });
    const handle = await programs.prompted(1);
    dropped = true;
    if (explicitFailure) {
      const report = { en: "The last issue no longer needs work.", zh: "最后一个问题不再需要处理。" };
      writeFileSync(workPaths(home, repository, 67).handback, JSON.stringify({ outcome: "failed", report }));
    }
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(67)).toEqual({ kind: "settled" });
    expect(handle.prompts).toHaveLength(1);
    expect(kinds(67)).not.toContain("message");
    expect(works.held()[0]).toMatchObject({ ended: true, live: false });
  });

  it("still asks for an open pull request from this branch when all issues closed during a turn", async () => {
    let dropped = false;
    const works = start({
      readClosedIssues: async (_context, numbers) => dropped ? [...numbers] : [],
      readBranchPull: async () => 48,
    });
    works.receive({ type: "work.start", task: task(68, { merged: [11] }) });
    const handle = await programs.prompted(1);
    dropped = true;
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("pull request #48 is still open from this branch");
    handBack(68, 48, [12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(68)).toMatchObject({ kind: "finished", pullRequest: 48 });
  });

  it("hands in the decisions the worker wrote with its pull request, and asks again for one that is not complete", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(36) });
    let handle = await programs.prompted(1);
    const decision = {
      chosen: { en: "Parsed dates in the local time zone", zh: "按本地时区解析日期" },
      why: { en: "The notes are written by one person in one place", zh: "笔记由一个人在同一个地方写" },
      otherOptions: { en: "UTC everywhere, which shifts evening notes to the next day", zh: "统一用 UTC，晚上的笔记会跑到第二天" },
    };
    handBack(36, 46, [11, 12], undefined, "", { decisions: [{ chosen: decision.chosen, why: decision.why }] });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('may list "decisions", each with "chosen", "why" and "otherOptions"');
    handBack(36, 46, [11, 12], undefined, "", { decisions: [decision] });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(36)).toMatchObject({ kind: "finished", pullRequest: 46, decisions: [decision] });
  });
});
