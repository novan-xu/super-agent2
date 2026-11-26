import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { loadBrainConfig } from "@super-agent2/brain";
import { windowsPowerShell } from "@super-agent2/programs";
import { gitHubAccounts, type Provider, providers } from "@super-agent2/protocol";
import { findExecutable, programSignedIn, systemProber } from "@super-agent2/runner";
import { githubToken } from "./credentials.js";
import type { Environment } from "./settings.js";

export async function preflight(environment: Environment, report: (line: string) => void): Promise<{ environment: Environment; available: readonly Provider[] }> {
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
  const ids = { gpt: "codex", claude: "claude", deepseek: "dsh" } as const;
  const prober = systemProber({ environment, cwd: configured.config.workspace });
  const programs: Record<string, string> = {};
  const checked = await Promise.all(providers.map(async (provider) => {
    const program = configured.config.providers[provider].program;
    const found = isAbsolute(program) ? (existsSync(program) ? program : undefined)
      : brainPath === undefined ? find(program) : findExecutable(program, brainPath, process.platform);
    if (found === undefined) return undefined;
    programs[variables[provider]] = found;
    return await programSignedIn(ids[provider], found, null, environment, prober) ? provider : undefined;
  }));
  const available = checked.filter((provider) => provider !== undefined);
  return { environment: { ...environment, ...programs }, available };
}

export function commandShell(environment: Environment): { powerShell?: string } {
  if (process.platform !== "win32") return {};
  const path = windowsPowerShell(environment);
  if (!existsSync(path)) throw new Error(`Windows PowerShell was not found at ${path}`);
  return { powerShell: path };
}
