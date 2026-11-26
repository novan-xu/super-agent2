import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { loadBrainConfig } from "@super-agent2/brain";
import { windowsPowerShell } from "@super-agent2/programs";
import { gitHubAccounts, providers } from "@super-agent2/protocol";
import { findExecutable, programDefinitions } from "@super-agent2/runner";
import { githubToken } from "./credentials.js";
import type { Environment } from "./settings.js";

export function preflight(environment: Environment, report: (line: string) => void): Environment {
  const find = (program: string) => findExecutable(program, environment, process.platform);
  if (find("git") === undefined) report("Git was not found on PATH. Workers need Git for repository work.");
  if (find("gh") === undefined) report("GitHub CLI was not found on PATH. Install gh for repository work.");
  for (const account of gitHubAccounts) {
    if (githubToken(account, environment) === undefined) report(`GitHub account ${account} is unavailable. Sign in with gh auth login or configure its token.`);
  }
  const configured = loadBrainConfig(environment);
  if (!configured.ok) throw new Error(configured.problems.join("\n"));
  const programDir = environment.BRAIN_PROGRAM_DIR;
  const path = Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const brainPath = programDir === undefined ? undefined : { PATH: `${join(programDir, "bin")}${delimiter}${path}` };
  const variables = { gpt: "BRAIN_CODEX_PROGRAM", claude: "BRAIN_CLAUDE_PROGRAM", deepseek: "BRAIN_DSH_PROGRAM" } as const;
  const programs: Record<string, string> = {};
  const reported = new Set<string>();
  for (const provider of providers) {
    const program = configured.config.providers[provider].program;
    const found = isAbsolute(program) ? (existsSync(program) ? program : undefined)
      : brainPath === undefined ? find(program) : findExecutable(program, brainPath, process.platform);
    if (found === undefined) {
      report(`Brain program ${program} was not found. Install it and sign in to use ${provider}.`);
      reported.add(program);
    } else programs[variables[provider]] = found;
  }
  for (const { executable } of programDefinitions({})) {
    if (!reported.has(executable) && find(executable) === undefined) {
      report(`Worker program ${executable} was not found. Install it and sign in to use it.`);
    }
  }
  return { ...environment, ...programs };
}

export function commandShell(environment: Environment): { powerShell?: string } {
  if (process.platform !== "win32") return {};
  const path = windowsPowerShell(environment);
  if (!existsSync(path)) throw new Error(`Windows PowerShell was not found at ${path}`);
  return { powerShell: path };
}
