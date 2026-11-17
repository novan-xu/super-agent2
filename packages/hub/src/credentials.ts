import type { GitHubAccount } from "@super-agent2/protocol";
import type { Environment } from "./targets.js";

export const accountTokenVariable: Readonly<Record<GitHubAccount, string>> = {
  "novan-xu": "GITHUB_TOKEN_NOVAN_XU",
  "nuofan-island": "GITHUB_TOKEN_NUOFAN_ISLAND",
};

export const forwardedVariables = [
  "WOODPECKER_SERVER",
  "WOODPECKER_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCESS_API_TOKEN",
] as const;

export type CredentialResult =
  | { readonly ok: true; readonly credentials: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

export type CredentialSource = (account: GitHubAccount) => CredentialResult;

export function environmentCredentials(environment: Environment): CredentialSource {
  return (account) => {
    const variable = accountTokenVariable[account];
    const token = environment[variable];
    if (token === undefined || token === "") {
      return { ok: false, reason: `${variable} is not set, so the hub has no GitHub token for ${account}` };
    }
    const credentials: Record<string, string> = { GH_TOKEN: token, GITHUB_TOKEN: token };
    for (const name of forwardedVariables) {
      const value = environment[name];
      if (value !== undefined && value !== "") {
        credentials[name] = value;
      }
    }
    return { ok: true, credentials };
  };
}
