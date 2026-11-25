import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tokenVariable } from "./identity.js";
import { workPaths } from "./workplace.js";
import { antigravityTaskPaths, outputFolder, taskPaths, taskQuestionPath } from "./task.js";
import { artifactsVariable } from "./storage.js";
import { repository, scratch, home, programs, sent, ghCalls, opened, inheritedCredentials, carried, git, start, task, events, kinds, ended, finishTurn, writingTask, writeOutput, summary } from "./testing/works.js";

describe("a task worker on the runner", () => {
  it("applies a new projects root without a restart and records local fallback when the NAS is missing", async () => {
    const root = realpathSync(scratch);
    const first = join(root, "First projects");
    const second = join(root, "Second projects");
    const nas = join(root, "Unreachable NAS");
    mkdirSync(first);
    mkdirSync(second);
    let projectsDir = first;
    const works = start({ storage: () => ({ projectsDir, artifactsDir: nas }) });
    works.receive({ type: "work.task", task: writingTask(55) });
    await works.idle();
    const local = join(home, "artifacts", "_tasks", "tickets", "t55");
    expect(programs.last().options.workspace).toBe(join(first, "_agent", "_tasks", "t55"));
    expect(programs.last().settings.environment[artifactsVariable]).toBe(local);
    expect(programs.last().prompts[0]).toContain(`Artifacts folder: ${local}`);
    expect(events(55).some(({ event }) => event.kind === "phase" && event.detail.includes("is unavailable"))).toBe(true);
    mkdirSync(nas);
    projectsDir = second;
    works.receive({ type: "work.task", task: writingTask(56) });
    await works.idle();
    expect(programs.handles[0]?.options.workspace).toBe(join(first, "_agent", "_tasks", "t55"));
    expect(programs.last().options.workspace).toBe(join(second, "_agent", "_tasks", "t56"));
    expect(programs.last().settings.environment[artifactsVariable]).toBe(join(nas, "_tasks", "tickets", "t56"));
  });

  it.each([false, true])("hands back within the Antigravity workspace for a fresh or repair task (repair: %s)", async (repair) => {
    const projectsDir = join(realpathSync(scratch), "Projects");
    mkdirSync(projectsDir);
    const works = start({ storage: () => ({ projectsDir }) });
    const ticket = 96;
    const folder = repair ? 95 : ticket;
    works.receive({ type: "work.task", task: writingTask(ticket, { folder, light: true }) });
    const handle = await programs.prompted(1);
    const workspace = join(projectsDir, "_agent", "_tasks", `t${folder}`);
    const handback = join(workspace, `.superagent2-t${ticket}`, "handback.json");
    expect(handle.options.workspace).toBe(workspace);
    expect(handle.prompts[0]).toContain(`Hand back by writing the JSON file at: ${handback}`);
    expect(handle.prompts[0]).toContain(join(workspace, `.superagent2-t${ticket}`, "question.json"));
    writeFileSync(join(workspace, "output", "result.txt"), "Finished");
    writeFileSync(handback, JSON.stringify({ report: summary, text: "result.txt" }));
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(ticket)).toMatchObject({ kind: "delivered", outcome: "done", text: "Finished" });
  });

  it("makes a scratch folder with the material, briefs the program without any repository, and delivers the text and files", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(20, { ticketReference: "at-2026-11-19" }) });
    const handle = await programs.prompted(1);
    const paths = taskPaths(home, 20);
    expect(handle.engine).toBe("antigravity");
    expect(handle.options).toEqual({ session: null, tools: null, workspace: paths.worktree });
    expect(handle.settings).toMatchObject({ program: "/programs/agy", model: "gemini-3.8-flash", effort: "high", processTree: true });
    expect(carried(handle.settings.environment)).toEqual([]);
    for (const name of Object.keys(inheritedCredentials)) {
      expect(handle.settings.environment[name], name).toBeUndefined();
    }
    expect(handle.settings.environment[tokenVariable]).toBeUndefined();
    expect(readFileSync(join(paths.worktree, "input", "notice.txt"), "utf8")).toBe("你好，世界。");
    expect(existsSync(join(paths.worktree, "input", "glossary"))).toBe(false);
    expect(existsSync(join(paths.worktree, "output"))).toBe(true);
    const prompt = handle.prompts[0] ?? "";
    expect(prompt).toContain("# Guidance for a task worker");
    expect(prompt).toContain("You are working on ticket at-2026-11-19.");
    expect(prompt).toContain("Translate the notice in input/notice.txt into English.");
    expect(prompt).toContain("- input/notice.txt, from pasted by the owner in the conversation");
    expect(prompt).toContain("- Not a file: get it yourself from https://example.com/glossary (named glossary)");
    expect(prompt).toContain(antigravityTaskPaths(paths, 20).handback);
    expect(prompt).toContain(join(paths.worktree, "output"));
    expect(works.busy()).toBe(1);
    handle.emit({ type: "session", session: "agy-conversation-20" });
    handle.emit({ type: "model", model: "gemini-3.8-flash", effort: null });
    writeOutput(20, { "result.md": "Hello, world.\n", "notes.pdf": Buffer.from([1, 2, 3, 4]) }, { text: "result.md", files: ["notes.pdf"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    const last = await ended(20);
    expect(last).toEqual({
      kind: "delivered",
      outcome: "done",
      text: "Hello, world.\n",
      files: [{ name: "notes.pdf", size: 4, mediaType: "application/pdf" }],
      report: summary,
    });
    expect(kinds(20)).toEqual(["phase:preparing", "phase:prepared", "phase:started", "phase:turn", "session", "ran", "phase:checking", "delivered"]);
    expect(handle.closed).toBe(true);
    expect(works.busy()).toBe(0);
    expect(ghCalls).toEqual([]);
    expect(existsSync(workPaths(home, repository, 20).worktree)).toBe(false);
  });

  it("delivers only files when there is no text, and tells the worker what is wrong with a hand-back", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(21) });
    let handle = await programs.prompted(1);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain("You have not handed back");
    writeOutput(21, {}, "not json");
    handle.emit({ type: "turn.finished", outcome: "completed" });
    handle = await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("is not valid JSON");
    writeOutput(21, { "table.xlsx": "cells" }, { files: ["table.xlsx"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(21)).toEqual({ kind: "delivered", outcome: "done", text: null, files: [{ name: "table.xlsx", size: 5, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }], report: summary });
  });

  it("asks again for a saved Agent_wring article ID and hands back only product IDs and the report", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(94, { light: true, agentWringArticle: true }) });
    const handle = await programs.prompted(1);
    expect(handle.prompts[0]).toContain("save_article tool using its html argument");
    expect(handle.prompts[0]).toContain('put each returned product_id once in "products"');
    writeOutput(94, {}, { report: summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('"products" listing the product IDs');
    const products = ["cc992985d3ce4559"];
    writeOutput(94, { "draft.md": "Worker summary", "draft.html": "Unsaved HTML" }, { report: summary, text: "draft.md", files: ["draft.html"], products });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(94)).toEqual({ kind: "delivered", outcome: "done", text: null, files: [], report: summary, products });
  });

  it.each([false, true])("fails after three idle task turns, with a hand-back file appearing during the first three turns: %s", async (file) => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(73) });
    const handle = await programs.prompted(1);
    await finishTurn(works, handle);
    await finishTurn(works, handle);
    expect(handle.prompts).toHaveLength(3);
    if (file) {
      writeOutput(73, {}, "not JSON");
      await finishTurn(works, handle);
      expect(handle.prompts).toHaveLength(4);
      await finishTurn(works, handle);
      await finishTurn(works, handle);
      expect(handle.prompts).toHaveLength(6);
      writeOutput(73, {}, "still not JSON");
    }
    await finishTurn(works, handle);
    expect(events(73).at(-1)?.event).toMatchObject({
      kind: "failed", failure: "no-pull-request", reason: expect.stringContaining(file ? "is not valid JSON" : "You have not handed back"),
    });
    expect(handle.prompts).toHaveLength(file ? 6 : 3);
  });

  it("refuses a hand-back that names a missing file or a path outside the output folder", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(22) });
    const handle = await programs.prompted(1);
    const paths = taskPaths(home, 22);
    writeOutput(22, {}, { files: ["missing.docx"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('names "missing.docx", but there is no such file');
    writeOutput(22, {}, { files: ["../handback.json"], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(3, handle);
    expect(handle.prompts[2]).toContain("is not a file name");
    expect(existsSync(paths.handback)).toBe(true);
  });

  it("refuses an empty text, and delivers files of any size and number, sending each part the hub asks for", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(23) });
    const handle = await programs.prompted(1);
    const big = Buffer.alloc(9 * 1024 * 1024, 3);
    big[big.length - 1] = 9;
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`part-${index}.txt`, `piece ${index}`]));
    writeOutput(23, { "empty.txt": "  \n", "big.bin": big, ...many }, { text: "empty.txt", summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    await programs.prompted(2, handle);
    expect(handle.prompts[1]).toContain('"empty.txt" is empty');
    writeOutput(23, {}, { files: ["big.bin", ...Object.keys(many)], summary });
    handle.emit({ type: "turn.finished", outcome: "completed" });
    const last = await ended(23);
    expect(last.kind === "delivered" ? last.files.length : 0).toBe(31);
    expect(last.kind === "delivered" ? last.files[0] : undefined).toEqual({ name: "big.bin", size: big.length, mediaType: "application/octet-stream" });
    const asked = { type: "work.file" as const, ticket: 23, attempt: 1, name: "big.bin", offset: 8 * 1024 * 1024, length: 1024 * 1024 };
    works.receive(asked);
    works.receive({ ...asked, name: "missing.bin", offset: 0 });
    const parts = await sent.until(() => sent.items.filter((message) => message.type === "work.file.part").length === 2).then(() =>
      sent.items.flatMap((message) => (message.type === "work.file.part" ? [message] : [])),
    );
    const served = parts.find((message) => message.name === "big.bin");
    expect(Buffer.from(served?.data ?? "", "base64").equals(big.subarray(8 * 1024 * 1024))).toBe(true);
    expect(served).toMatchObject({ offset: 8 * 1024 * 1024, problem: null });
    expect(parts.find((message) => message.name === "missing.bin")).toMatchObject({ data: null, problem: expect.stringContaining("missing.bin") as unknown as string });
  });

  it("pauses a light worker for a question and resumes it with the owner's answer after a runner restart", async () => {
    const task = { ...writingTask(24), light: true as const };
    const first = start();
    first.receive({ type: "work.task", task });
    const before = await programs.prompted(1);
    before.emit({ type: "session", session: "light-question-session" });
    const paths = taskPaths(home, 24);
    expect(before.prompts[0]).toContain(taskQuestionPath(antigravityTaskPaths(paths, 24)));
    writeFileSync(taskQuestionPath(antigravityTaskPaths(paths, 24)), JSON.stringify({ question: "邮件收件人是谁？" }));
    await finishTurn(first, before);
    const question = events(24).find((message) => message.event.kind === "question")?.event;
    expect(question).toMatchObject({ kind: "question", text: "邮件收件人是谁？" });
    expect(first.held()).toMatchObject([{ live: true, ended: false }]);
    expect(before.prompts).toHaveLength(1);
    await first.close();
    opened.splice(opened.indexOf(first), 1);

    const restarted = start();
    restarted.receive({ type: "work.task", task });
    await restarted.idle();
    const resumed = programs.last();
    expect(resumed.options.session).toBe("light-question-session");
    expect(resumed.prompts).toEqual([]);
    expect(events(24).filter((message) => message.event.kind === "question").map((message) => message.event)).toEqual([question, question]);
    restarted.receive({ type: "work.message", ticket: 24, attempt: 1, id: "answer", from: "owner", text: "给 Maya" });
    await programs.changed.until(() => resumed.prompts.length === 1);
    expect(resumed.prompts[0]).toContain("给 Maya");
    expect(existsSync(taskQuestionPath(antigravityTaskPaths(paths, 24)))).toBe(false);
    writeFileSync(antigravityTaskPaths(paths, 24).handback, JSON.stringify({ report: { en: "Done", zh: "写好了" } }));
    await finishTurn(restarted, resumed);
    expect(await ended(24)).toMatchObject({ kind: "delivered", report: { zh: "写好了" } });
  });

  it("stops and removes the scratch folder without touching Git, and lists the work after a restart", async () => {
    const first = start();
    first.receive({ type: "work.task", task: writingTask(24) });
    const before = await programs.prompted(1);
    before.emit({ type: "session", session: "agy-conversation-24" });
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = start();
    expect(again.held()).toEqual([{ ticket: 24, attempt: 1, last: 5, live: false, ended: false }]);
    again.receive({ type: "work.task", task: writingTask(24) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const resumed = programs.last();
    expect(resumed.options.session).toBe("agy-conversation-24");
    expect(resumed.prompts[0]).toContain("runner restarted");
    expect(kinds(24)).toContain("phase:resumed");
    again.receive({ type: "work.stop", ticket: 24, save: true, remove: true });
    await again.idle();
    expect(resumed.closed).toBe(true);
    expect(existsSync(taskPaths(home, 24).folder)).toBe(false);
    expect(kinds(24).slice(-2)).toEqual(["stopped", "phase:removed"]);
    expect(ghCalls).toEqual([]);
  });

  it("reports a program that is unavailable as unavailable, with its reason and time, and not as a failure", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(25) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "unavailable", reason: "resource exhausted", until: 1_900_000_000_000, category: "limit" });
    expect(await ended(25)).toEqual({ kind: "unavailable", reason: "resource exhausted", until: 1_900_000_000_000, unsent: [], category: "limit" });
    expect(handle.closed).toBe(true);
    expect(works.held()).toEqual([{ ticket: 25, attempt: 1, last: events(25).length, live: false, ended: true }]);
  });

  it("still reports a program that crashes or errors as a failure", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(26) });
    const handle = await programs.prompted(1);
    handle.emit({ type: "failed", reason: "The program crashed", lostSession: false });
    expect(await ended(26)).toEqual({ kind: "failed", failure: "program", reason: "The program crashed" });
  });

  it("names the messages it had held back but not yet given to the program, so the hub can give them to the next worker", async () => {
    programs.steer = "queued";
    const works = start();
    works.receive({ type: "work.start", task: task(27) });
    const handle = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 27, attempt: 1, id: "m-held", from: "owner", text: "Also update the README" });
    await sent.until(() => events(27).some((message) => message.event.kind === "message"));
    handle.emit({ type: "unavailable", reason: "You've hit your limit", until: null });
    expect(await ended(27)).toEqual({ kind: "unavailable", reason: "You've hit your limit", until: null, unsent: ["m-held"] });
  });

  it("starts the next program in the same folder with the earlier worker's commits and uncommitted changes listed", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(28) });
    const first = await programs.prompted(1);
    const paths = workPaths(home, repository, 28);
    writeFileSync(join(paths.worktree, "done.txt"), "done");
    await git(paths.worktree).must(["add", "done.txt"], paths.worktree);
    await git(paths.worktree).must(["commit", "-m", "Add the done file"], paths.worktree);
    writeFileSync(join(paths.worktree, "half.txt"), "half");
    first.emit({ type: "unavailable", reason: "You've hit your limit", until: null });
    expect(await ended(28)).toMatchObject({ kind: "unavailable" });
    works.receive({ type: "work.start", task: task(28, { attempt: 2, engine: "claude", model: "claude-opus-5-5", effort: "high", takeover: true, note: "You are taking over this ticket from an earlier worker." }) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const second = programs.last();
    expect(second.engine).toBe("claude");
    expect(second.options.session).toBeNull();
    const prompt = second.prompts[0] ?? "";
    expect(prompt).toContain("You are taking over this ticket from an earlier worker.");
    expect(prompt).toContain("Commits on sa2/ticket-28-abcd that are not on main:");
    expect(prompt).toContain("Add the done file");
    expect(prompt).toContain("?? half.txt");
    expect(readFileSync(join(paths.worktree, "half.txt"), "utf8")).toBe("half");
    expect(events(28, 2).map((message) => message.seq)[0]).toBe(1);
  });

  it("keeps what a task worker produced when the next program takes over, and lists it", async () => {
    const works = start();
    works.receive({ type: "work.task", task: writingTask(29) });
    const first = await programs.prompted(1);
    const paths = taskPaths(home, 29);
    mkdirSync(outputFolder(paths), { recursive: true });
    writeFileSync(join(outputFolder(paths), "draft.txt"), "a draft");
    first.emit({ type: "unavailable", reason: "RESOURCE_EXHAUSTED", until: null });
    expect(await ended(29)).toMatchObject({ kind: "unavailable" });
    works.receive({ type: "work.task", task: writingTask(29, { attempt: 2, engine: "codex", model: "gpt-6-luna", effort: "low", takeover: true, note: "You are taking over this task." }) });
    await programs.changed.until(() => programs.handles.length === 2 && programs.last().prompts.length === 1);
    const prompt = programs.last().prompts[0] ?? "";
    expect(prompt).toContain("You are taking over this task.");
    expect(prompt).toContain("draft.txt (7 bytes)");
    expect(readFileSync(join(outputFolder(paths), "draft.txt"), "utf8")).toBe("a draft");
  });

  it("saves the work of an attempt that already ended when the hub moves it to another machine, and says so", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(30) });
    const first = await programs.prompted(1);
    const paths = workPaths(home, repository, 30);
    writeFileSync(join(paths.worktree, "half.txt"), "half");
    first.emit({ type: "unavailable", reason: "You've hit your limit", until: null });
    expect(await ended(30)).toMatchObject({ kind: "unavailable" });
    works.receive({ type: "work.stop", ticket: 30, save: true, remove: true });
    await works.idle();
    const stopped = events(30).find((message) => message.event.kind === "stopped")?.event;
    expect(stopped).toMatchObject({ kind: "stopped", saved: true });
    const seed = join(scratch, "seed");
    await git(seed).must(["fetch", "origin", "sa2/ticket-30-abcd"], seed);
    expect((await git(seed).must(["show", "FETCH_HEAD:half.txt"], seed)).trim()).toBe("half");
  });
});
