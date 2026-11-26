import { execFileSync } from "node:child_process";
import { accountTokenVariable, environmentCredentials } from "@super-agent2/hub";
import type { GitHubAccount } from "@super-agent2/protocol";
import { findExecutable } from "@super-agent2/runner";
import type { Environment } from "./settings.js";

export function githubToken(account: GitHubAccount, environment: Environment, gh = findExecutable("gh", environment, process.platform)): string | undefined {
  const configured = environment[accountTokenVariable[account]]?.trim();
  if (configured) return configured;
  if (gh === undefined) return undefined;
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(GH_TOKEN|GITHUB_TOKEN|GH_PROMPT_DISABLED)$/i.test(name)));
  try {
    return execFileSync(gh, ["auth", "token", "--hostname", "github.com", "--user", account], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
      env: { ...env, GH_PROMPT_DISABLED: "1" },
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function localCredentials(environment: Environment) {
  return (account: GitHubAccount) => environmentCredentials({ ...environment, [accountTokenVariable[account]]: githubToken(account, environment) })(account);
}
