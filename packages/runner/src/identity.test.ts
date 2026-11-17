import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitConfigParameters, readIdentity, tokenVariable, workerEnvironment, writeGhShims } from "./identity.js";
import { mergeEnvironment } from "./shell.js";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "runner-identity-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function fill(environment: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["credential", "fill"], { cwd: folder, env: { ...environment }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.once("close", () => resolve(Buffer.concat(out).toString("utf8")));
    child.stdin.end("protocol=https\nhost=github.com\n\n");
  });
}

describe("the worker's GitHub identity", () => {
  it("names the token in a variable that programs which hide secrets still pass on", () => {
    expect(tokenVariable).not.toMatch(/KEY|PASSWORD|SECRET|TOKEN/i);
    expect(gitConfigParameters()).not.toMatch(/KEY|PASSWORD|SECRET|TOKEN/);
  });

  it("puts the shims first on the path and gives the token to gh and git, with the account's commit identity", () => {
    const environment = workerEnvironment({ Path: "C:\\Windows" }, "test-token", "C:\\shims", { name: "Owner", email: "1+owner@users.noreply.github.com" }, "win32");
    expect(environment).toMatchObject({
      PATH: "C:\\shims;C:\\Windows",
      GH_TOKEN: "test-token",
      GITHUB_TOKEN: "test-token",
      [tokenVariable]: "test-token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_EMAIL: "1+owner@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Owner",
    });
    expect(workerEnvironment({ PATH: "/usr/bin" }, "t", "/shims", undefined, "darwin")).not.toHaveProperty("GIT_AUTHOR_NAME");
    expect(workerEnvironment({ PATH: "/usr/bin" }, "t", "/shims", undefined, "darwin")["PATH"]).toBe("/shims:/usr/bin");
  });

  it("makes git answer GitHub's password from the token variable, and nothing else", async () => {
    const base = mergeEnvironment(process.env, { HOME: folder, USERPROFILE: folder, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(folder, "none") });
    const answer = await fill(mergeEnvironment(base, workerEnvironment(base, "test-worker-token", folder, undefined)));
    expect(answer).toContain("username=x-access-token");
    expect(answer).toContain("password=test-worker-token");
  });

  it("writes a gh shim that passes the token variable on as GH_TOKEN", () => {
    writeGhShims(folder, "C:\\Program Files\\GitHub CLI\\gh.exe", "win32");
    const windows = readFileSync(join(folder, "gh.cmd"), "utf8");
    expect(windows).toContain(`if not defined GH_TOKEN set "GH_TOKEN=%${tokenVariable}%"`);
    expect(windows).toContain('"C:\\Program Files\\GitHub CLI\\gh.exe" %*');
    writeGhShims(folder, "/opt/homebrew/bin/gh", "darwin");
    const posix = readFileSync(join(folder, "gh"), "utf8");
    expect(posix.startsWith("#!/bin/sh\n")).toBe(true);
    expect(posix).toContain(`GH_TOKEN="\${${tokenVariable}:-}"`);
    expect(posix).toContain(`exec '/opt/homebrew/bin/gh' "$@"`);
  });

  it("reads the account's name and no-reply address, and gives up quietly when it cannot", async () => {
    const identity = await readIdentity(
      () => Promise.resolve({ code: 0, stdout: JSON.stringify({ login: "novan-xu", id: 42, name: "Novan" }), stderr: "" }),
      "gh",
      {},
      folder,
    );
    expect(identity).toEqual({ name: "Novan", email: "42+novan-xu@users.noreply.github.com" });
    expect(await readIdentity(() => Promise.resolve({ code: 1, stdout: "", stderr: "offline" }), "gh", {}, folder)).toBeUndefined();
  });
});
