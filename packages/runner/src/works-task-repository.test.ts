import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tokenVariable } from "./identity.js";
import { taskPaths } from "./task.js";
import { repository, token, scratch, home, programs, carried, git, start, ended, writingTask, writeOutput } from "./testing/works.js";

describe("a task worker with a repository", () => {
  const recipe = (target: string | string[]) => JSON.stringify({ target, deploy: "node deploy.mjs {commit}", health: { command: "node health.mjs {commit}" }, rollback: "node rollback.mjs {commit}" });

  async function commitDeploymentFile(target: string | string[]): Promise<string> {
    const seed = join(scratch, "seed");
    const repo = git(seed);
    mkdirSync(join(seed, ".superagent2"), { recursive: true });
    writeFileSync(join(seed, ".superagent2", "deployment.json"), recipe(target));
    await repo.must(["add", "-A"], seed);
    await repo.must(["commit", "-m", "Declare the deployment"], seed);
    await repo.must(["push", "origin", "main"], seed);
    return (await repo.must(["rev-parse", "HEAD"], seed)).trim();
  }

  it("checks the repository out at its commit beside the scratch folder, works in the checkout as the account, and hands back the commit", async () => {
    const seed = join(scratch, "seed");
    const commit = (await git(seed).must(["rev-parse", "HEAD"], seed)).trim();
    const works = start({ machine: "pc" });
    works.receive({
      type: "work.task",
      task: writingTask(40, { engine: "codex", model: "gpt-6-luna", effort: "low", checkout: { repository, account: "novan-xu", commit, ref: null }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }),
    });
    const handle = await programs.prompted(1);
    const paths = taskPaths(home, 40, repository);
    expect(handle.options.workspace).toBe(paths.worktree);
    expect(readFileSync(join(paths.worktree, "README.md"), "utf8").trim()).toBe("sandbox");
    expect((await git(paths.worktree).must(["rev-parse", "HEAD"], paths.worktree)).trim()).toBe(commit);
    expect(readFileSync(join(paths.folder, "scratch", "input", "notice.txt"), "utf8")).toBe("你好，世界。");
    expect(handle.settings.environment[tokenVariable]).toBe(token);
    expect(carried(handle.settings.environment)).toEqual([]);
    const prompt = handle.prompts[0] ?? "";
    expect(prompt).toContain("# Guidance for a task worker");
    expect(prompt).toContain("This machine: pc");
    expect(prompt).toContain(`Checkout of ${repository}: ${paths.worktree}, at commit ${commit}`);
    expect(prompt).not.toContain("Deployment recipe");
    writeOutput(40, {}, { outcome: "done", report: { en: "Ran it", zh: "跑完了" } }, repository);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(40)).toEqual({ kind: "delivered", outcome: "done", commit, text: null, files: [], report: { en: "Ran it", zh: "跑完了" } });
    works.receive({ type: "work.stop", ticket: 40, save: false, remove: true });
    await works.idle();
    expect(existsSync(paths.worktree)).toBe(false);
    expect(existsSync(paths.folder)).toBe(false);
  });

  it("hands back a failed outcome with its report", async () => {
    const works = start({ machine: "pc" });
    works.receive({ type: "work.task", task: writingTask(41, { checkout: { repository, account: "novan-xu", commit: null, ref: "main" }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }) });
    const handle = await programs.prompted(1);
    writeOutput(41, { "deploy.log": "it did not come up" }, { outcome: "failed", report: { en: "It did not come up; rolled back.", zh: "没起来，已回滚。" }, files: ["deploy.log"] }, repository);
    handle.emit({ type: "turn.finished", outcome: "completed" });
    expect(await ended(41)).toMatchObject({ kind: "delivered", outcome: "failed", report: { zh: "没起来，已回滚。" }, files: [{ name: "deploy.log" }] });
  });

  it("deploys only on the machine its deployment file names, and refuses another before any program starts", async () => {
    await commitDeploymentFile(["mini", "air"]);
    const elsewhere = start({ machine: "pc" });
    elsewhere.receive({ type: "work.task", task: writingTask(42, { deploys: true, checkout: { repository, account: "novan-xu", commit: null, ref: "main" }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }) });
    const refused = await ended(42);
    expect(refused).toMatchObject({ kind: "failed", failure: "prepare" });
    expect(refused.kind === "failed" ? refused.reason : "").toContain("names these machines: mini, air, and this machine is pc");
    expect(programs.handles).toHaveLength(0);
    const commit = await commitDeploymentFile(["mini", "pc"]);
    const here = start({ machine: "pc" });
    here.receive({ type: "work.task", task: writingTask(43, { deploys: true, checkout: { repository, account: "novan-xu", commit: null, ref: "main" }, environment: { GH_TOKEN: token, GITHUB_TOKEN: token } }) });
    const handle = await programs.prompted(1);
    expect(handle.prompts[0]).toContain(`at commit ${commit}`);
    expect(handle.prompts[0]).toContain(`Deployment recipe: ${join(taskPaths(home, 43, repository).worktree, ".superagent2", "deployment.json")}`);
    expect(handle.prompts[0]).toContain(`Deploy: node deploy.mjs ${commit}\nHealth: node health.mjs ${commit}\nRollback: node rollback.mjs ${commit}`);
  });
});
