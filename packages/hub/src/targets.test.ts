import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStream } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { environmentCredentials, forwardedVariables } from "./credentials.js";
import { defaultTargets } from "./hub.js";
import { commandEnvironment, type Execution, type Job, remoteScript, scriptTarget, shellQuote, sshArgv } from "./targets.js";
import { testConfig } from "./testing/access.js";

describe("commandEnvironment", () => {
  it("keeps the hub's environment, drops both account tokens and adds the credentials", () => {
    const environment = commandEnvironment(
      { PATH: "/bin", GITHUB_TOKEN_NOVAN_XU: "a", GITHUB_TOKEN_NUOFAN_ISLAND: "b", GH_TOKEN: "old", EMPTY: undefined },
      { GH_TOKEN: "new", GITHUB_TOKEN: "new" },
    );
    expect(environment).toEqual({ PATH: "/bin", GH_TOKEN: "new", GITHUB_TOKEN: "new" });
  });

  it("replaces a variable whose name differs only in case", () => {
    expect(commandEnvironment({ gh_token: "old" }, { GH_TOKEN: "new" })).toEqual({ GH_TOKEN: "new" });
  });
});

describe("environmentCredentials", () => {
  const environment = {
    GITHUB_TOKEN_NOVAN_XU: "token-a",
    GITHUB_TOKEN_NUOFAN_ISLAND: "token-b",
    WOODPECKER_SERVER: "https://ci.example.com",
    WOODPECKER_TOKEN: "token-w",
    CLOUDFLARE_API_TOKEN: "token-c",
    ACCESS_AUD: "not-forwarded",
  };

  it("gives the chosen account's token as GH_TOKEN and GITHUB_TOKEN, with Woodpecker and Cloudflare", () => {
    const source = environmentCredentials(environment);
    expect(source("novan-xu")).toEqual({
      ok: true,
      credentials: {
        GH_TOKEN: "token-a",
        GITHUB_TOKEN: "token-a",
        WOODPECKER_SERVER: "https://ci.example.com",
        WOODPECKER_TOKEN: "token-w",
        CLOUDFLARE_API_TOKEN: "token-c",
      },
    });
    const island = source("nuofan-island");
    expect(island.ok && island.credentials["GH_TOKEN"]).toBe("token-b");
    expect(forwardedVariables).not.toContain("ACCESS_AUD");
  });

  it("names the missing variable and never a value", () => {
    const result = environmentCredentials({ GITHUB_TOKEN_NOVAN_XU: "token-a" })("nuofan-island");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("GITHUB_TOKEN_NUOFAN_ISLAND");
    expect(JSON.stringify(result)).not.toContain("token-a");
  });
});

describe("the NAS over SSH", () => {
  it("keeps credentials out of the command line", () => {
    const argv = sshArgv({ destination: "owner@nas.local", port: 2222, identityFile: "/run/secrets/nas_key" });
    expect(argv).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      "-p",
      "2222",
      "-i",
      "/run/secrets/nas_key",
      "--",
      "owner@nas.local",
      "bash -s",
    ]);
  });

  it("is a target only when a destination is configured", () => {
    expect(defaultTargets(testConfig("data"), {}).map((target) => target.name)).toEqual(["hub"]);
    const withNas = { ...testConfig("data"), nas: { destination: "owner@nas.local" } };
    expect(defaultTargets(withNas, {}).map((target) => target.name)).toEqual(["hub", "nas"]);
  });

  it("quotes anything for the remote shell", () => {
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    const script = remoteScript({ command: "echo 'a b'", cwd: "/volume1/my folder", credentials: { GH_TOKEN: "x'y" } });
    expect(script).toContain(`export GH_TOKEN='x'\\''y'`);
    expect(script).toContain(`cd -- '/volume1/my folder' || exit 1`);
    expect(script).toContain(`sh -c 'echo '\\''a b'\\''' </dev/null 3<&- &`);
    expect(script.endsWith("run\n")).toBe(true);
  });

  it("refuses a credential name the shell cannot hold", () => {
    expect(() => remoteScript({ command: "x", cwd: undefined, credentials: { "BAD-NAME": "v" } })).toThrow();
  });
});

interface Collected {
  readonly chunks: Array<[OutputStream, string]>;
  readonly execution: Execution;
}

function runScript(job: Job): Collected {
  const chunks: Array<[OutputStream, string]> = [];
  const target = scriptTarget({ name: "nas", argv: ["bash", "-s"], environment: process.env });
  const execution = target.run(job, (stream, data) => chunks.push([stream, data.toString("utf8")]));
  return { chunks, execution };
}

function text(collected: Collected): string {
  return collected.chunks.map(([, data]) => data).join("");
}

function waitForText(collected: Collected, wanted: string, onData: (listener: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (text(collected).includes(wanted)) {
        resolve();
      }
    };
    onData(check);
    check();
  });
}

describe.skipIf(process.platform === "win32")("the remote script, run by a local bash in place of ssh", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "hub-remote-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns output, exit code, credentials and folder", async () => {
    const collected = runScript({
      command: `printf '%s\\n' "$GH_TOKEN" "$(pwd -P)"; echo oops >&2; exit 4`,
      cwd: workDir,
      credentials: { GH_TOKEN: "remote-test-token" },
    });
    const end = await collected.execution.ended;
    expect(end).toEqual({ exitCode: 4, signal: null });
    const stdout = collected.chunks.filter(([stream]) => stream === "stdout").map(([, data]) => data).join("");
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("remote-test-token");
    expect(lines[1]?.endsWith(workDir.split("/").pop() ?? "")).toBe(true);
    expect(collected.chunks.filter(([stream]) => stream === "stderr").map(([, data]) => data).join("")).toBe("oops\n");
  });

  it("stops the command and everything it started when told to", async () => {
    const listeners: Array<() => void> = [];
    const chunks: Array<[OutputStream, string]> = [];
    const target = scriptTarget({ name: "nas", argv: ["bash", "-s"], environment: process.env });
    const execution = target.run(
      { command: `(sh -c 'echo ready; exec sleep 100000'; echo never) & wait`, cwd: undefined, credentials: {} },
      (stream, data) => {
        chunks.push([stream, data.toString("utf8")]);
        for (const listener of listeners) {
          listener();
        }
      },
    );
    const collected = { chunks, execution };
    await waitForText(collected, "ready", (listener) => listeners.push(listener));
    await execution.stop();
    const end = await execution.ended;
    expect(end.exitCode).not.toBe(0);
    expect(text(collected)).not.toContain("never");
  });
});
