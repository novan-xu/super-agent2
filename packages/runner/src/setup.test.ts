import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRunnerSetup } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseModels, parseSettings, readSettingsFile, runnerFiles } from "./config.js";
import { createLedger } from "./ledger.js";
import { writeSecretFile } from "./secret-file.js";
import { runSetup } from "./setup.js";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "runner-setup-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const token = "r".repeat(43);

describe("the runner's settings", () => {
  it("reads the settings file and names what is missing or wrong", () => {
    expect(parseSettings('A=1\r\n\r\nB = "two words"\nnot a setting\n')).toEqual({ A: "1", B: "two words" });
    const ok = loadConfig({
      SUPERAGENT2_HUB: "https://agent.example.com",
      MACHINE_NAME: "pc",
      ACCESS_CLIENT_ID: "id.access",
      ACCESS_CLIENT_SECRET: "secret",
      RUNNER_TOKEN: token,
      RUNNER_MODELS_DSH: "deepseek-flash:low|high, deepseek-pro:max",
    });
    expect(ok).toMatchObject({
      ok: true,
      config: { slots: 2, models: { dsh: [{ id: "deepseek-flash", efforts: ["low", "high"] }, { id: "deepseek-pro", efforts: ["max"] }] } },
    });
    const bad = loadConfig({ SUPERAGENT2_HUB: "ftp://x", MACHINE_NAME: "hub", RUNNER_TOKEN: "short", RUNNER_SLOTS: "two" });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.problems).toEqual([
      "SUPERAGENT2_HUB must be an https or http address",
      "MACHINE_NAME must be lower-case letters, digits and dashes",
      "ACCESS_CLIENT_ID is required",
      "ACCESS_CLIENT_SECRET is required",
      "RUNNER_TOKEN is not a runner token",
      "RUNNER_SLOTS must be a whole number",
    ]);
    expect(parseModels("a:b:c")).toBeUndefined();
  });

  it("keeps the settings under a folder of the runner's own", () => {
    const files = runnerFiles(join(folder, ".superagent2"));
    expect(files.settings).toBe(join(folder, ".superagent2", "runner.env"));
  });
});

describe("the setup", () => {
  function answers(...lines: string[]) {
    const asked: string[] = [];
    return {
      asked,
      ask: async (question: string) => {
        asked.push(question);
        return lines.shift();
      },
    };
  }

  it("saves the line the hub printed in a file only the user can read", async () => {
    const settings = join(folder, "home", "runner.env");
    writeFileSync(join(folder, "placeholder"), "");
    const commands: string[][] = [];
    const said: string[] = [];
    const input = answers(encodeRunnerSetup({ hub: "https://agent.example.com", name: "pc", accessClientId: "id.access", accessClientSecret: "secret", runnerToken: token }));
    const saved = await runSetup({
      settingsFile: settings,
      ask: input.ask,
      say: (line) => said.push(line),
      platform: "win32",
      execute: (program, args) => commands.push([program, ...args]),
    });
    expect(saved).toBe(true);
    expect(input.asked).toHaveLength(1);
    expect(readSettingsFile(settings)).toEqual({
      SUPERAGENT2_HUB: "https://agent.example.com",
      MACHINE_NAME: "pc",
      ACCESS_CLIENT_ID: "id.access",
      ACCESS_CLIENT_SECRET: "secret",
      RUNNER_TOKEN: token,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 2)).toEqual(["icacls", `${settings}.new`]);
    expect(commands[0]?.slice(2, 5)).toEqual(["/inheritance:r", "/grant:r", expect.stringMatching(/:F$/)]);
    expect(said.join("\n")).not.toContain(token);
    expect(said.join("\n")).not.toContain("secret\n");
  });

  it("asks for the secret of a reused service token and keeps the other settings", async () => {
    const settings = join(folder, "runner.env");
    writeFileSync(settings, "RUNNER_SLOTS=4\nRUNNER_MODELS_DSH=deepseek-flash:high\nRUNNER_TOKEN=old\n");
    const input = answers(encodeRunnerSetup({ hub: "https://agent.example.com", name: "pc", accessClientId: "id.access", runnerToken: token }), "  typed-secret ");
    expect(await runSetup({ settingsFile: settings, ask: input.ask, say: () => undefined, platform: "linux", execute: () => undefined })).toBe(true);
    expect(input.asked[1]).toContain("id.access");
    expect(readSettingsFile(settings)).toMatchObject({ RUNNER_SLOTS: "4", RUNNER_MODELS_DSH: "deepseek-flash:high", RUNNER_TOKEN: token, ACCESS_CLIENT_SECRET: "typed-secret" });
    if (process.platform !== "win32") {
      expect(statSync(settings).mode & 0o777).toBe(0o600);
    }
  });

  it("takes the secret and the runner token on the next lines, as the install script hands them over", async () => {
    const settings = join(folder, "runner.env");
    const input = answers(encodeRunnerSetup({ hub: "https://agent.example.com", name: "studio", accessClientId: "id.access" }), "0123abcd", token);
    expect(await runSetup({ settingsFile: settings, ask: input.ask, say: () => undefined, platform: "linux", execute: () => undefined })).toBe(true);
    expect(input.asked).toHaveLength(3);
    expect(readSettingsFile(settings)).toEqual({
      SUPERAGENT2_HUB: "https://agent.example.com",
      MACHINE_NAME: "studio",
      ACCESS_CLIENT_ID: "id.access",
      ACCESS_CLIENT_SECRET: "0123abcd",
      RUNNER_TOKEN: token,
    });
    const missing = answers(encodeRunnerSetup({ hub: "https://agent.example.com", name: "studio", accessClientId: "id.access" }), "0123abcd", "short");
    expect(await runSetup({ settingsFile: join(folder, "other.env"), ask: missing.ask, say: () => undefined, platform: "linux", execute: () => undefined })).toBe(false);
    expect(readSettingsFile(join(folder, "other.env"))).toBeUndefined();
  });

  it("changes nothing for a line that is not the hub's", async () => {
    const settings = join(folder, "runner.env");
    expect(await runSetup({ settingsFile: settings, ask: answers("hello").ask, say: () => undefined, platform: "linux", execute: () => undefined })).toBe(false);
    expect(readSettingsFile(settings)).toBeUndefined();
  });

  it("leaves no file behind when the permissions cannot be set", () => {
    const settings = join(folder, "runner.env");
    expect(() =>
      writeSecretFile(settings, "X=1\n", "win32", () => {
        throw new Error("icacls failed");
      }),
    ).toThrow("icacls failed");
    expect(readSettingsFile(settings)).toBeUndefined();
    expect(() => readFileSync(`${settings}.new`)).toThrow();
  });
});

describe("the ledger of running processes", () => {
  it("stops what an earlier runner left running since the same boot, and nothing from an earlier boot", async () => {
    const path = join(folder, "running.json");
    const killed: number[] = [];
    const first = createLedger({ path, boot: () => 1_000_000, kill: async (pid) => void killed.push(pid) });
    first.add(11);
    first.add(12);
    first.remove(12);
    first.add(13);
    const again = createLedger({ path, boot: () => 1_000_500, kill: async (pid) => void killed.push(pid) });
    expect(await again.cleanup()).toEqual([11, 13]);
    expect(killed).toEqual([11, 13]);
    again.add(21);
    const afterReboot = createLedger({ path, boot: () => 9_000_000, kill: async (pid) => void killed.push(pid) });
    expect(await afterReboot.cleanup()).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ boot: 9_000_000, pids: [] });
  });
});
