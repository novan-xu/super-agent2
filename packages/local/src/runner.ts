import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { secretVariables, type Hub } from "@super-agent2/hub";
import { formatSettings, loadConfig, modelsVariable, readSettingsFile, runnerFiles, settingNames, writeSecretFile } from "@super-agent2/runner";
import { programIds } from "@super-agent2/protocol";
import type { Environment } from "./settings.js";

type RunnerSettings = { readonly url: string; readonly clientId: string; readonly clientSecret: string; readonly tokenOnly: boolean };

export function runnerSettings(localUrl: string, access: boolean, environment: Environment): RunnerSettings {
  if (!access) return { url: localUrl, clientId: "local", clientSecret: "", tokenOnly: true };
  const url = URL.parse(environment[settingNames.hub] ?? "");
  const clientId = environment[settingNames.accessClientId];
  const clientSecret = environment[settingNames.accessClientSecret];
  if (url?.protocol !== "https:" || url.username !== "" || url.password !== "" || !clientId || !clientSecret) {
    throw new Error("Local Access mode requires SUPERAGENT2_HUB (the HTTPS Access URL), ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET for the local runner");
  }
  return { url: url.origin, clientId, clientSecret, tokenOnly: false };
}

export function prepareRunner(hub: Hub, home: string, projects: string, settings: RunnerSettings, env: Environment): void {
  const path = runnerFiles(home).settings;
  const previous = readSettingsFile(path);
  const machine = hub.machines.active("local");
  const oldToken = previous?.[settingNames.runnerToken];
  const keep = machine?.accessClientId === settings.clientId && oldToken !== undefined && hub.machines.byToken(oldToken)?.name === "local";
  const values: Record<string, string> = {
    [settingNames.hub]: settings.url,
    [settingNames.name]: "local",
    [settingNames.accessClientId]: settings.tokenOnly ? "" : settings.clientId,
    [settingNames.accessClientSecret]: settings.clientSecret,
    [settingNames.runnerToken]: keep ? oldToken : "a".repeat(43),
    PROJECTS_DIR: projects,
  };
  for (const name of [settingNames.slots, "ARTIFACTS_DIR", ...programIds.map(modelsVariable)]) {
    const value = env[name];
    if (value !== undefined) values[name] = value;
  }
  const loaded = loadConfig(values, settings.tokenOnly);
  if (!loaded.ok) throw new Error(loaded.problems.join("\n"));
  if (!keep) {
    if (machine !== undefined) hub.machines.revoke("local");
    values[settingNames.runnerToken] = hub.machines.add({ name: "local", accessClientId: settings.clientId, hub: settings.url }).token;
  }
  if (JSON.stringify(previous) !== JSON.stringify(values)) writeSecretFile(path, formatSettings(values));
}

export function superviseRunner(home: string, tokenOnly: boolean, environment: Environment, report: (line: string) => void, checkout?: string): () => Promise<void> {
  const privateNames = new Set([...secretVariables, "RUNNER_TOKEN"].filter((name) => !["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "DEEPSEEK_API_KEY"].includes(name)));
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !privateNames.has(name.toUpperCase())));
  const entry = fileURLToPath(new URL("./runner-process.js", import.meta.url));
  let child: ReturnType<typeof fork> | undefined;
  let closed = Promise.resolve();
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;
  let stopping = false;
  let ready = false;

  const stopChild = () => {
    if (ready && child?.connected) child.send("stop", (error) => { if (error && child?.connected) child.disconnect(); });
  };

  const start = () => {
    const startedAt = performance.now();
    const current = fork(entry, [home, tokenOnly ? "--loopback" : "--access", ...(checkout === undefined ? [] : [checkout])], { env, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true, execArgv: [] });
    child = current;
    ready = false;
    current.on("message", (message) => {
      if (message !== "ready") return;
      ready = true;
      if (stopping) stopChild();
    });
    closed = new Promise<void>((resolve) => {
      const ended = (code: number | null, signal: NodeJS.Signals | null) => {
        child = undefined;
        resolve();
        if (stopping) return;
        if (performance.now() - startedAt > 60000) attempt = 0;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5));
        report(`Local runner exited (${signal ?? code ?? "spawn error"}). Restarting in ${delay / 1000} s.`);
        retry = setTimeout(start, delay);
      };
      current.on("error", (error) => {
        report(`Local runner: ${error.message}`);
        if (current.pid === undefined) ended(null, null);
      });
      current.once("exit", ended);
    });
  };
  start();
  return async () => {
    stopping = true;
    clearTimeout(retry);
    stopChild();
    await closed;
  };
}
