import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkEngine } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { fakeAntigravitySource, fakeClaudeSource, fakeCodexSource, fakeDshSource, readLog, writeFake } from "../../programs/src/testing/programs.js";
import { ended, events, git, handBack, home, repository, scratch, start, task } from "./testing/works.js";
import { workPaths } from "./workplace.js";
import { defaultAdapters, engineExecutables } from "./works.js";

const fakeSources: Record<WorkEngine, string> = {
  codex: fakeCodexSource, claude: fakeClaudeSource, dsh: fakeDshSource, antigravity: fakeAntigravitySource,
};

function withProgram(engine: WorkEngine, storage?: () => { projectsDir: string }) {
  const log = join(scratch, "program.jsonl");
  const fake = writeFake(scratch, `${engine}.mjs`, fakeSources[engine]);
  const works = start({
    adapters: defaultAdapters,
    environment: { ...process.env, FAKE_LOG: log },
    findProgram: (name) => name === "gh" ? "gh-for-tests" : name === engineExecutables[engine] ? fake : undefined,
    ...(storage === undefined ? {} : { storage }),
  });
  return { works, log };
}

function sessionOf(ticket: number): string {
  for (const { event } of events(ticket)) {
    if (event.kind === "session") return event.session;
  }
  throw new Error(`Worker ${ticket} did not emit a session`);
}

describe("follow-up assignments", () => {
  it.each(["codex", "claude", "dsh", "antigravity"] as const)("resumes %s in the previous worktree on a fresh branch", async (engine) => {
    let projectsDir = join(scratch, "projects");
    mkdirSync(projectsDir);
    const { works, log } = withProgram(engine, () => ({ projectsDir }));
    const original = task(41, { engine });
    const originalPath = join(realpathSync(projectsDir), "_agent", repository.split("/")[1]!, "t41");
    const seed = join(scratch, "seed");
    const repo = git(seed);
    const fromCommit = (await repo.must(["rev-parse", "HEAD"], seed)).trim();
    handBack(41, 80, [11, 12]);
    works.receive({ type: "work.start", task: original });
    expect(await ended(41)).toMatchObject({ kind: "finished" });
    const session = sessionOf(41);
    expect(existsSync(originalPath)).toBe(true);
    works.receive({ type: "work.stop", ticket: 41, save: false, remove: true });
    await works.idle();
    expect(existsSync(originalPath)).toBe(false);
    const originalCalls = readLog(log).length;
    await works.close();

    projectsDir = join(scratch, "new-projects");
    mkdirSync(projectsDir);
    const restarted = start({
      adapters: defaultAdapters,
      environment: { ...process.env, FAKE_LOG: log },
      findProgram: (name) => name === "gh" ? "gh-for-tests" : name === engineExecutables[engine] ? join(scratch, `${engine}.mjs`) : undefined,
      storage: () => ({ projectsDir }),
    });
    writeFileSync(join(seed, "README.md"), "a later change\n");
    await repo.must(["commit", "-am", "Changed on the default branch"], seed);
    await repo.must(["push", "origin", "main"], seed);
    const head = (await repo.must(["rev-parse", "HEAD"], seed)).trim();
    const note = "Adjust the headings on original issue #11.";
    const followUp = task(42, {
      engine, session, note, folder: 41, issues: [original.issues[0]!],
      followUp: { fromCommit, workspaceOf: 41, resumeOriginal: true, takeoverNote: note },
    });
    handBack(42, 81, [11]);
    restarted.receive({ type: "work.start", task: followUp });
    expect(await ended(42)).toMatchObject({ kind: "finished", pullRequest: 81, closes: [11] });
    expect(events(42).map(({ event }) => event)).toContainEqual({ kind: "follow-up", outcome: "resumed" });
    expect((await repo.must(["rev-parse", "HEAD"], originalPath)).trim()).toBe(head);
    expect((await repo.must(["branch", "--show-current"], originalPath)).trim()).toBe(followUp.branch);
    expect(existsSync(join(projectsDir, "_agent"))).toBe(false);
    const calls = readLog(log).slice(originalCalls);
    const wire = JSON.stringify(calls);
    if (engine === "codex") {
      expect(calls).toContainEqual(expect.objectContaining({ method: "thread/resume", params: expect.objectContaining({ threadId: session, cwd: originalPath }) }));
    } else if (engine === "dsh") {
      expect(calls).toContainEqual(expect.objectContaining({ method: "session/resume", params: { sessionId: session } }));
    } else if (engine === "claude") {
      expect(wire).toContain(JSON.stringify(["--resume", session]).slice(1, -1));
    } else {
      expect(wire).toContain(JSON.stringify(["--conversation", session]).slice(1, -1));
      expect(calls[0]?.cwd).toBe(originalPath);
    }
    expect(wire).toContain(note);
    expect(wire).toContain("Changed on the default branch");
  });

  it("starts fresh with the original issue, request and pull request if Codex lost the session", async () => {
    const { works, log } = withProgram("codex");
    const takeoverNote = "Original issue #11. Make the title smaller. Prior pull request #80.";
    const assignment = task(42, {
      session: "missing", note: "Continue in the original session.", folder: 41,
      followUp: { fromCommit: null, workspaceOf: 41, resumeOriginal: true, takeoverNote },
    });
    handBack(42, 81, [11, 12]);
    works.receive({ type: "work.start", task: assignment });
    expect(await ended(42)).toMatchObject({ kind: "finished", pullRequest: 81 });
    expect(events(42).map(({ event }) => event)).toContainEqual({ kind: "follow-up", outcome: "takeover", lostSession: true });
    const calls = readLog(log);
    expect(calls.find(({ method }) => method === "thread/resume")?.params).toMatchObject({ threadId: "missing" });
    expect(calls.some(({ method }) => method === "thread/start")).toBe(true);
    expect(JSON.stringify(calls.find(({ method }) => method === "turn/start"))).toContain(takeoverNote);
    expect(existsSync(workPaths(home, repository, 42, 41).worktree)).toBe(true);
  });
});
