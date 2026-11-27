import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TaskAssignment } from "@super-agent2/protocol";
import { createGit, mergeEnvironment, type ProcessRunner, runProcess } from "@super-agent2/runner";
import { expect, it } from "vitest";
import { fastForwardCheckout, localBuilder, stageRestart } from "./local-build.js";

it("builds a fetched commit in isolation, keeps the old checkout after failure, and fast-forwards after activation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-build-test-")));
  const remote = join(root, "remote");
  const checkout = join(root, "checkout");
  const home = join(root, "state");
  const environment = mergeEnvironment(process.env, { GIT_CONFIG_NOSYSTEM: "1" });
  const git = createGit(runProcess, environment);
  try {
    mkdirSync(remote);
    await git.must(["init", "-b", "main"], remote);
    await git.must(["config", "user.name", "Build Test"], remote);
    await git.must(["config", "user.email", "test@example.test"], remote);
    await git.must(["commit", "--allow-empty", "-m", "Initial commit"], remote);
    const previous = (await git.must(["rev-parse", "HEAD"], remote)).trim();
    await git.must(["clone", "--", remote, checkout], root);
    await git.must(["remote", "set-url", "origin", "https://github.com/owner/super-agent2.git"], checkout);
    await git.must(["config", `url.${remote}.insteadOf`, "https://github.com/owner/super-agent2.git"], checkout);
    await git.must(["config", "user.name", "Build Test"], checkout);
    await git.must(["config", "user.email", "test@example.test"], checkout);
    writeFileSync(join(remote, "updated.txt"), "New version");
    await git.must(["add", "--", "updated.txt"], remote);
    await git.must(["commit", "-m", "Update"], remote);
    const target = (await git.must(["rev-parse", "HEAD"], remote)).trim();

    const task = TaskAssignment.parse({
      ticket: 1, attempt: 1, title: "Build local", task: "Build the local edition.", materials: [], deploys: true, localBuild: true,
      checkout: { repository: "owner/super-agent2", account: "novan-xu", commit: target, ref: null },
      engine: "codex", model: "codex", effort: "high", session: null, note: null,
    });
    let failBuild = true;
    const executed: string[][] = [];
    const run: ProcessRunner = async (file, args, options) => {
      if (/^git(?:\.exe)?$/i.test(basename(file))) return runProcess(file, args, options);
      const command = process.platform === "win32" ? Buffer.from(args.at(-1)!, "base64").toString("utf16le") : args.join(" ");
      executed.push([options.cwd, command]);
      if (command.includes("pnpm build")) {
        if (failBuild) return { code: 1, stdout: "", stderr: "A build fixture failed" };
        const output = join(options.cwd, "packages", "local", "dist");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "main.js"), "export {};");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const build = localBuilder(home, checkout, environment, run);
    const log: string[] = [];
    const runBuild = () => build(task, new AbortController().signal, (line) => log.push(line));
    await expect(runBuild()).rejects.toThrow("A build fixture failed");
    expect(log.join("")).toContain("A build fixture failed");
    expect(existsSync(join(checkout, "updated.txt"))).toBe(false);
    expect(existsSync(join(home, "local-builds", target))).toBe(false);
    expect((await git.must(["rev-parse", "HEAD"], checkout)).trim()).toBe(previous);
    expect(() => stageRestart(home, checkout, target)).toThrow("No complete local build");

    failBuild = false;
    await expect(runBuild()).resolves.toBe(target);
    expect(executed).toHaveLength(4);
    expect(executed.every(([cwd]) => cwd === join(home, "local-builds", target))).toBe(true);
    expect(existsSync(join(checkout, "updated.txt"))).toBe(false);
    stageRestart(home, checkout, target);
    expect(JSON.parse(readFileSync(join(home, "local-build-pending.json"), "utf8"))).toEqual({ checkout, commit: target });
    await expect(fastForwardCheckout({ repository: "owner/super-agent2", checkout, commit: previous }, home, target, environment)).rejects.toThrow("instead of");
    await fastForwardCheckout({ repository: "owner/super-agent2", checkout, commit: target }, home, target, environment);
    expect((await git.must(["rev-parse", "HEAD"], checkout)).trim()).toBe(target);
    expect(readFileSync(join(checkout, "updated.txt"), "utf8")).toBe("New version");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
