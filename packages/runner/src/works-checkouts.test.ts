import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactsVariable } from "./storage.js";
import { token, scratch, remote, programs, git, start, task, events } from "./testing/works.js";

describe("a worker on the runner", () => {
  it("shares the owner's checkout between tickets and retains NAS outputs after restart and cleanup", async () => {
    const root = realpathSync(scratch);
    const projects = join(root, "Code Projects");
    const nas = join(root, "NAS");
    const owner = join(projects, "Sandbox in use");
    mkdirSync(projects);
    mkdirSync(nas);
    const repo = git(projects);
    await repo.must(["clone", remote, owner], projects);
    await repo.must(["remote", "set-url", "origin", "git@GitHub.com:Novan-Xu/Super-Agent-Sandbox.git"], owner);
    await repo.must(["switch", "-c", "owners-branch"], owner);
    writeFileSync(join(owner, "README.md"), "owner's edit");
    writeFileSync(join(owner, "notes.txt"), "owner's notes");
    const config = readFileSync(join(owner, ".git", "config"), "utf8");
    const status = await repo.must(["status", "--porcelain"], owner);
    const seed = await repo.must(["rev-parse", "HEAD"], owner);

    const works = start({ storage: () => ({ projectsDir: projects, artifactsDir: nas }) });
    for (const ticket of [51, 52]) works.receive({ type: "work.start", task: task(ticket) });
    await works.idle();
    expect(programs.handles).toHaveLength(2);
    for (const ticket of [51, 52]) {
      const worktree = join(projects, "_agent", "Sandbox in use", `t${ticket}`);
      const artifacts = join(nas, "super-agent-sandbox", "tickets", `t${ticket}`);
      const handle = programs.handles.find((item) => item.options.workspace === worktree);
      expect(handle?.settings.environment[artifactsVariable]).toBe(artifacts);
      expect(handle?.settings.environment.GH_TOKEN).toBe(token);
      expect(handle?.prompts[0]).toContain(`Artifacts folder: ${artifacts}`);
      expect((await repo.must(["branch", "--show-current"], worktree)).trim()).toBe(task(ticket).branch);
      expect(await repo.must(["rev-parse", "HEAD"], worktree)).toBe(seed);
      writeFileSync(join(artifacts, "check.log"), `Checks for ${ticket}`);
    }
    expect(existsSync(join(projects, "super-agent-sandbox"))).toBe(false);
    await works.close();
    const cleanupLogs: string[] = [];
    const restarted = start({ storage: () => ({}), log: (line) => cleanupLogs.push(line) });
    expect(restarted.held().map(({ ticket }) => ticket).sort()).toEqual([51, 52]);
    for (const ticket of [51, 52]) restarted.receive({ type: "work.stop", ticket, save: false, remove: true });
    await restarted.idle();
    expect(cleanupLogs).toEqual([]);
    for (const ticket of [51, 52]) {
      expect(existsSync(join(projects, "_agent", "Sandbox in use", `t${ticket}`))).toBe(false);
      expect(existsSync(join(nas, "super-agent-sandbox", "tickets", `t${ticket}`, "check.log"))).toBe(true);
      expect(await repo.must(["branch", "--list", task(ticket).branch], owner)).toBe("");
    }
    expect(await repo.must(["status", "--porcelain"], owner)).toBe(status);
    expect((await repo.must(["branch", "--show-current"], owner)).trim()).toBe("owners-branch");
    expect(await repo.must(["rev-parse", "HEAD"], owner)).toBe(seed);
    expect(readFileSync(join(owner, ".git", "config"), "utf8")).toBe(config);
    expect(readFileSync(join(owner, "README.md"), "utf8")).toBe("owner's edit");
    expect(readFileSync(join(owner, "notes.txt"), "utf8")).toBe("owner's notes");
  });

  it.each(["missing", "different"])("reuses a same-name checkout with %s origin without changing owner state", async (origin) => {
    const projects = join(realpathSync(scratch), "Projects");
    const owner = join(projects, "Super-Agent-Sandbox");
    mkdirSync(projects);
    const repo = git(projects);
    await repo.must(["clone", remote, owner], projects);
    if (origin === "missing") await repo.must(["remote", "remove", "origin"], owner);
    else await repo.must(["remote", "set-url", "origin", "https://example.com/other.git"], owner);
    await repo.must(["switch", "-c", "owner-branch"], owner);
    if (origin === "different") {
      const tree = (await repo.must(["rev-parse", "HEAD^{tree}"], owner)).trim();
      const other = (await repo.must(["commit-tree", tree, "-m", "Other remote"], owner)).trim();
      await repo.must(["update-ref", "refs/remotes/origin/main", other], owner);
    }
    writeFileSync(join(owner, "README.md"), "owner edit");
    const config = readFileSync(join(owner, ".git", "config"), "utf8");
    const status = await repo.must(["status", "--porcelain"], owner);
    const refs = await repo.must(["for-each-ref", "refs/remotes/origin", "--format=%(refname) %(objectname)"], owner);
    const works = start({ storage: () => ({ projectsDir: projects }) });
    works.receive({ type: "work.start", task: task(55) });
    await works.idle();
    const worktree = join(projects, "_agent", "Super-Agent-Sandbox", "t55");
    expect(programs.last().options.workspace).toBe(worktree);
    expect(await repo.must(["rev-parse", "HEAD"], worktree)).toBe(await repo.must(["rev-parse", "refs/remotes/superagent2/main"], owner));
    expect(events(55).some(({ event }) => "detail" in event && event.detail.includes(`Matched checkout ${owner} by folder name; origin: ${origin === "missing" ? "not configured" : "https://example.com/other.git"}`))).toBe(true);
    expect(readFileSync(join(owner, ".git", "config"), "utf8")).toBe(config);
    expect(await repo.must(["status", "--porcelain"], owner)).toBe(status);
    expect((await repo.must(["branch", "--show-current"], owner)).trim()).toBe("owner-branch");
    expect(await repo.must(["for-each-ref", "refs/remotes/origin", "--format=%(refname) %(objectname)"], owner)).toBe(refs);
  });

  it("prefers an origin match over a same-name checkout and refuses a non-checkout fallback", async () => {
    const projects = join(realpathSync(scratch), "Projects");
    const sameName = join(projects, "SUPER-AGENT-SANDBOX");
    const matching = join(projects, "other folder");
    mkdirSync(sameName, { recursive: true });
    writeFileSync(join(sameName, "keep"), "owner file");
    const repo = git(projects);
    await repo.must(["clone", remote, matching], projects);
    const works = start({ storage: () => ({ projectsDir: projects }) });
    works.receive({ type: "work.start", task: task(56) });
    await works.idle();
    expect(programs.last().options.workspace).toBe(join(projects, "_agent", "other folder", "t56"));
    await repo.must(["remote", "remove", "origin"], matching);
    works.receive({ type: "work.start", task: task(57) });
    await works.idle();
    expect(events(57).at(-1)?.event).toMatchObject({ kind: "failed", failure: "prepare", reason: expect.stringContaining("not a Git checkout") });
    expect(readFileSync(join(sameName, "keep"), "utf8")).toBe("owner file");
  });

  it("clones an absent checkout and leaves an unrelated directory at a worktree path alone", async () => {
    const projects = join(realpathSync(scratch), "Projects");
    const managed = join(projects, "_agent", "super-agent-sandbox");
    const occupied = join(managed, "t53");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "keep.txt"), "owner file");
    const works = start({ storage: () => ({ projectsDir: projects }) });
    works.receive({ type: "work.start", task: task(53) });
    works.receive({ type: "work.start", task: task(54) });
    await works.idle();
    expect(events(53).at(-1)?.event).toMatchObject({ kind: "failed", failure: "prepare", reason: expect.stringContaining("already occupied") });
    expect(programs.handles).toHaveLength(1);
    expect(programs.last().options.workspace).toBe(join(managed, "t54"));
    expect(readFileSync(join(projects, "super-agent-sandbox", "README.md"), "utf8")).toContain("sandbox");
    works.receive({ type: "work.stop", ticket: 53, save: false, remove: true });
    await works.idle();
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("owner file");
  });
});
