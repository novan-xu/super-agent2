import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSettings, runnerFiles } from "./config.js";
import {
  type InstallContext,
  install,
  launchAgentPath,
  launchAgentPlist,
  macosLabel,
  uninstall,
  windowsRunCommand,
  windowsRunKey,
  windowsRunValue,
} from "./install.js";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "runner-install-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function context(platform: NodeJS.Platform, settings = true) {
  const files = runnerFiles(join(folder, ".superagent2"));
  if (settings) {
    mkdirSync(files.home, { recursive: true });
    writeFileSync(
      files.settings,
      formatSettings({
        SUPERAGENT2_HUB: "https://agent.example.com",
        MACHINE_NAME: "mac-mini",
        ACCESS_CLIENT_ID: "id.access",
        ACCESS_CLIENT_SECRET: "secret",
        RUNNER_TOKEN: "r".repeat(43),
      }),
    );
  }
  const commands: string[][] = [];
  const said: string[] = [];
  const started: string[] = [];
  const value: InstallContext = {
    files,
    platform,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    mainPath: "C:\\work\\super-agent2\\packages\\runner\\dist\\main.js",
    environment: { PATH: "/usr/local/bin:/usr/bin:/bin", SUPERAGENT2_RUNNER_HOME: files.home },
    execute: (program, args) => {
      commands.push([program, ...args]);
      if (program === "launchctl" && args[0] === "bootout") {
        throw new Error("not loaded");
      }
    },
    say: (line) => said.push(line),
    launchAgents: join(folder, "LaunchAgents"),
    uid: 501,
    startNow: () => started.push("supervisor"),
  };
  return { value, commands, said, started };
}

describe("the Windows installer", () => {
  it("starts the runner at login through the user's Run key and now", () => {
    const { value, commands, started } = context("win32");
    expect(install(value)).toBe(true);
    expect(windowsRunCommand(value)).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\super-agent2\\packages\\runner\\dist\\main.js" launch');
    expect(commands).toEqual([["reg", "add", windowsRunKey, "/v", windowsRunValue, "/t", "REG_SZ", "/d", windowsRunCommand(value), "/f"]]);
    expect(windowsRunKey.startsWith("HKCU\\")).toBe(true);
    expect(started).toEqual(["supervisor"]);
  });

  it("removes the Run value and stops the runner, keeping the settings unless asked", async () => {
    const { value, commands } = context("win32");
    writeFileSync(value.files.supervisor, "999999999\n");
    expect(await uninstall(value, false)).toBe(true);
    expect(commands).toEqual([["reg", "delete", windowsRunKey, "/v", windowsRunValue, "/f"]]);
    expect(existsSync(value.files.supervisor)).toBe(false);
    expect(existsSync(value.files.settings)).toBe(true);
    expect(await uninstall(value, true)).toBe(true);
    expect(existsSync(value.files.home)).toBe(false);
  });

  it("refuses to install before the setup", () => {
    const { value, commands, said } = context("win32", false);
    expect(install(value)).toBe(false);
    expect(commands).toEqual([]);
    expect(said.join("\n")).toContain("run the setup first");
  });
});

describe("the macOS installer", () => {
  it("writes a launch agent that keeps the runner alive and loads it", () => {
    const { value, commands } = context("darwin");
    expect(install(value)).toBe(true);
    const plist = readFileSync(launchAgentPath(value), "utf8");
    expect(plist).toBe(launchAgentPlist(value));
    expect(plist).toContain(`<string>${macosLabel}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>PATH</key>\n    <string>/usr/local/bin:/usr/bin:/bin</string>");
    expect(plist).not.toContain("secret");
    expect(commands).toEqual([
      ["launchctl", "bootout", `gui/501/${macosLabel}`],
      ["launchctl", "bootstrap", "gui/501", launchAgentPath(value)],
    ]);
  });

  it("unloads and deletes the launch agent", async () => {
    const { value, commands } = context("darwin");
    install(value);
    commands.length = 0;
    expect(await uninstall(value, false)).toBe(true);
    expect(commands).toEqual([["launchctl", "bootout", `gui/501/${macosLabel}`]]);
    expect(existsSync(launchAgentPath(value))).toBe(false);
  });

  it("escapes what it writes into the property list", () => {
    const { value } = context("darwin");
    expect(launchAgentPlist({ ...value, mainPath: "/a & b/<main>.js" })).toContain("<string>/a &amp; b/&lt;main&gt;.js</string>");
  });
});
