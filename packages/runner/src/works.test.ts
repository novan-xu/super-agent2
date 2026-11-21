import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tokenVariable } from "./identity.js";
import { workPaths } from "./workplace.js";
import { repository, token, scratch, home, programs, sent, ghCalls, opened, carried, git, start, task, events, kinds, ended, handBack } from "./testing/works.js";

describe("a worker on the runner", () => {
  it("prepares a worktree on a new branch, briefs the program, and hands back the pull request", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(5) });
    const handle = await programs.prompted(1);
    const paths = workPaths(home, repository, 5);
    expect(handle.options).toEqual({ session: null, tools: null, workspace: paths.worktree });
    expect(handle.settings).toMatchObject({ program: "/programs/codex", model: "gpt-6-luna", effort: "low", client: "super-agent2-worker", processTree: true });
    expect(handle.settings.environment["GH_TOKEN"]).toBe(token);
    expect(handle.settings.environment["GITHUB_TOKEN"]).toBe(token);
    expect(handle.settings.environment[tokenVariable]).toBe(token);
    expect(carried(handle.settings.environment)).toEqual([]);
    for (const name of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "RUNNER_TOKEN", "ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      expect(handle.settings.environment[name], name).toBeUndefined();
    }
    expect(handle.settings.environment["GIT_CONFIG_PARAMETERS"]).toContain("credential.https://github.com.helper=");
    const prompt = handle.prompts[0] ?? "";
    expect(prompt).toContain("# Guidance for a worker");
    expect(prompt.indexOf("#11 First issue")).toBeLessThan(prompt.indexOf("#12 Second issue"));
    expect(prompt).toContain(paths.handback);
    expect(prompt).not.toContain(token);
    expect((await git(paths.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], paths.worktree)).trim()).toBe("sa2/ticket-5-abcd");
    expect(works.busy()).toBe(1);
    handle.emit({ type: "session", session: "thread-5" });
    handle.emit({ type: "model", model: "gpt-6-luna", effort: "low" });
    handle.emit({ type: "text", block: "b", delta: "working" });
    handBack(5, 40, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(5)).toEqual({ kind: "finished", pullRequest: 40, url: `https://github.com/${repository}/pull/40`, closes: [11, 12], report: { en: "Did both issues", zh: "两个问题都做完了" } });
    expect(kinds(5)).toEqual(["phase:preparing", "phase:prepared", "phase:started", "phase:turn", "session", "ran", "text", "phase:checking", "finished"]);
    expect(events(5).map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(handle.closed).toBe(true);
    expect(works.busy()).toBe(0);
    expect(works.held()).toEqual([{ ticket: 5, attempt: 1, last: 9, live: false, ended: true }]);
    expect(JSON.stringify(sent.items)).not.toContain(token);
    expect(readFileSync(join(paths.folder, "work.json"), "utf8")).not.toContain(token);
  });

  it("passes assigned MCP servers to the worker program", async () => {
    const works = start();
    const extraMcp = [{ name: "Agent_wring", url: "http://mini/mcp", token: "example-secret" }];
    works.receive({ type: "work.start", task: { ...task(55), extraMcp } });
    const handle = await programs.prompted(1);
    expect(handle.options.extraMcp).toEqual(extraMcp);
  });

  it("takes a message into the running turn, or queues it for the next turn when the program cannot", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(7) });
    const handle = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 7, attempt: 1, id: "m-1", from: "owner", text: "Also update the README" });
    await programs.changed.until(() => handle.steered.length === 1);
    expect(handle.steered[0]).toBe("[Message from the owner] Also update the README");
    programs.steer = "queued";
    works.receive({ type: "work.message", ticket: 7, attempt: 1, id: "m-2", from: "brain", text: "Keep it short" });
    await sent.until(() => kinds(7).filter((kind) => kind === "message").length === 2);
    expect(events(7).filter((message) => message.event.kind === "message").map((message) => message.event)).toEqual([
      { kind: "message", id: "m-1", from: "owner", text: "Also update the README", delivery: "steered" },
      { kind: "message", id: "m-2", from: "brain", text: "Keep it short", delivery: "queued" },
    ]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toBe("[Message from the brain] Keep it short");
    handBack(7, 42, [11, 12]);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect((await ended(7)).kind).toBe("finished");
  });

  it("records a program failure with its reason", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(8) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "failed", reason: "codex exited with code 1", lostSession: false });
    expect(await ended(8)).toEqual({ kind: "failed", failure: "program", reason: "codex exited with code 1" });
    expect(works.busy()).toBe(0);
  });

  it("stops a worker, removes its worktree and branch, and forgets it", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(9) });
    const handle = await programs.prompted(1);
    const paths = workPaths(home, repository, 9);
    expect(existsSync(paths.worktree)).toBe(true);
    works.receive({ type: "work.stop", ticket: 9, save: false, remove: true });
    await works.idle();
    expect(handle.closed).toBe(true);
    expect(kinds(9).slice(-2)).toEqual(["stopped", "phase:removed"]);
    expect(existsSync(paths.worktree)).toBe(false);
    expect(existsSync(paths.folder)).toBe(false);
    const branches = await git(paths.clone).must(["branch", "--list", "sa2/ticket-9-abcd"], paths.clone);
    expect(branches.trim()).toBe("");
    expect(works.held()).toEqual([]);
    expect(works.busy()).toBe(0);
  });

  it("runs two tickets of one repository at once in separate worktrees on separate branches", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(10) });
    works.receive({ type: "work.start", task: task(11) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.handles.every((handle) => handle.prompts.length === 1));
    expect(works.busy()).toBe(2);
    const [first, second] = [workPaths(home, repository, 10), workPaths(home, repository, 11)];
    expect(first.worktree).not.toBe(second.worktree);
    expect(first.clone).toBe(second.clone);
    writeFileSync(join(first.worktree, "ten.txt"), "ten\n");
    expect(existsSync(join(second.worktree, "ten.txt"))).toBe(false);
    expect((await git(second.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], second.worktree)).trim()).toBe("sa2/ticket-11-abcd");
  });

  it("after a restart, lists its work and resumes the same session in the same worktree when told to", async () => {
    const first = start();
    first.receive({ type: "work.start", task: task(12) });
    const before = await programs.prompted(1);
    before.emit({ type: "session", session: "thread-12" });
    before.emit({ type: "text", block: "b", delta: "half done" });
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = start();
    expect(again.held()).toEqual([{ ticket: 12, attempt: 1, last: 7, live: false, ended: false }]);
    again.receive({ type: "work.sync", ticket: 12, attempt: 1, after: 5 });
    expect(sent.items.slice(-2).map((message) => (message.type === "work.event" ? message.seq : 0))).toEqual([6, 7]);
    again.receive({ type: "work.start", task: task(12) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const after = programs.last();
    expect(after).not.toBe(before);
    expect(after.options.session).toBe("thread-12");
    expect(after.prompts[0]).toContain("runner restarted");
    expect(kinds(12)).toContain("phase:resumed");
    expect(events(12).at(-1)?.seq).toBeGreaterThan(7);
  });

  it("does not start a second worker when it is told to start the same attempt again", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(13) });
    await programs.prompted(1);
    works.receive({ type: "work.start", task: task(13) });
    await works.idle();
    expect(programs.handles).toHaveLength(1);
    expect(works.busy()).toBe(1);
  });

  it("replaces a running attempt with a newer one in the same worktree", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(14) });
    const old = await programs.prompted(1);
    works.receive({ type: "work.start", task: task(14, { attempt: 2, engine: "claude", model: "claude-haiku-5-5", note: "The owner reassigned this ticket" }) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    expect(old.closed).toBe(true);
    const fresh = programs.last();
    expect(fresh.engine).toBe("claude");
    expect(fresh.prompts[0]).toContain("The owner reassigned this ticket");
    expect(fresh.options.workspace).toBe(old.options.workspace);
    expect(works.held()).toEqual([expect.objectContaining({ ticket: 14, attempt: 2, live: true })]);
  });

  it("fails cleanly when the repository cannot be prepared", async () => {
    const works = start({ remote: () => join(scratch, "missing.git") });
    works.receive({ type: "work.start", task: task(15) });
    const last = await ended(15);
    expect(last).toMatchObject({ kind: "failed", failure: "prepare" });
    expect(programs.handles).toHaveLength(0);
    expect(ghCalls).toEqual([["api", "user"]]);
  });
});
