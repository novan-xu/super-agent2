import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckReply, RunCheck } from "@super-agent2/protocol";
import { expect, it } from "vitest";
import { createChecks } from "./checks.js";

it("checks the committed head in its own detached checkout, saves the full output and strips secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-check-test-"));
  const projects = join(root, "projects");
  const source = join(projects, "repo");
  const home = join(root, "runner");
  mkdirSync(source, { recursive: true });
  const repository = "owner/repo";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const replies: CheckReply[] = [];
  const received = Promise.withResolvers<CheckReply>();
  const checks = createChecks({
    home, environment: { ...process.env, GH_TOKEN: "secret", HUB_PRIVATE: "secret", NODE_OPTIONS: "--invalid-environment-option" },
    storage: () => ({ projectsDir: projects }), available: () => true, changed: () => undefined,
    send: (reply) => {
      replies.push(reply);
      if (reply.result.state !== "busy") received.resolve(reply);
    },
  });
  try {
    git("init", "--quiet", "--template=");
    git("remote", "add", "origin", `https://github.com/${repository}.git`);
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    writeFileSync(join(source, "check.mjs"), [
      'import { readFileSync } from "node:fs";',
      'if (readFileSync("tracked.txt", "utf8").trim() !== "committed") throw new Error("The source checkout was reused");',
      'if (process.env.GH_TOKEN || process.env.HUB_PRIVATE || process.env.NODE_OPTIONS) throw new Error("A secret was inherited");',
      'process.stdout.write("Start of check\\n" + "x".repeat(28000) + "\\n");',
      'process.stderr.write("End of check\\n");',
      'process.exitCode = 7;',
    ].join("\n"));
    git("add", ".");
    git("-c", "user.name=Test Runner", "-c", "user.email=runner@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Commit the fixture");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(source, "tracked.txt"), "uncommitted change\n");
    const request: RunCheck = { type: "check.run", id: randomUUID(), ticket: 1, repository, head, command: "node check.mjs", pullRequest: 10 };
    checks.receive(request);
    checks.receive(request);
    const competing = randomUUID();
    checks.receive({ ...request, id: competing });
    expect(replies).toEqual([{ type: "check.reply", id: competing, result: { state: "busy" } }]);
    const { result } = await received.promise;
    expect(result).toMatchObject({ state: "finished", exitCode: 7, output: expect.stringContaining("End of check") });
    if (result.state !== "finished") throw new Error(JSON.stringify(result));
    expect(result.output).not.toContain("Start of check");
    const full = readFileSync(result.artifact, "utf8");
    expect(full).toContain("Start of check");
    expect(full).toContain("End of check");
    expect(readFileSync(join(source, "tracked.txt"), "utf8")).toBe("uncommitted change\n");
    expect(git("worktree", "list").split(/\r?\n/)).toHaveLength(1);
    checks.receive(request);
    expect(replies[2]).toEqual(replies[1]);
    expect(checks.busy()).toBe(0);
  } finally {
    await checks.close();
    rmSync(root, { recursive: true, force: true });
  }
});
