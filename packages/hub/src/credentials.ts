import { text } from "@super-agent2/catalog";
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

export const credentialVariables: readonly string[] = ["GH_TOKEN", "GITHUB_TOKEN", ...Object.values(accountTokenVariable), ...forwardedVariables];

export const secretVariables: readonly string[] = [
  ...credentialVariables,
  "ACCESS_CLIENT_ID",
  "ACCESS_CLIENT_SECRET",
  "TUNNEL_TOKEN",
  "BRAIN_CLAUDE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "DEEPSEEK_API_KEY",
  "VAPID_PRIVATE_KEY",
  "SUPER_AGENT_HUB_TOKEN",
];

const secretShapes: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /:\/\/[^\s/:@]+:[^\s/@]{6,}@/,
];

const assignedSecrets: readonly RegExp[] = [
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CLIENT_ID)\s*[:=]\s*["']?[^\s"']{8,}/,
  /\b(?:password|passwd|api[ _-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /(?:密码|口令|令牌|密钥)\s*(?:[:：=]|是)\s*\S{6,}/u,
];

export function secretValues(environment: Environment, extra: readonly string[] = []): string[] {
  const values = secretVariables.map((name) => environment[name]);
  return [...values, ...extra].filter((value): value is string => value !== undefined && value.trim().length >= 8).map((value) => value.trim());
}

export function holdsCredential(text: string, values: readonly string[] = []): boolean {
  if (secretShapes.some((shape) => shape.test(text)) || assignedSecrets.some((shape) => shape.test(text))) {
    return true;
  }
  return values.some((value) => value.length >= 8 && text.includes(value));
}

export type CredentialResult =
  | { readonly ok: true; readonly credentials: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

export type CredentialSource = (account: GitHubAccount) => CredentialResult;

export function environmentCredentials(environment: Environment): CredentialSource {
  return (account) => {
    const variable = accountTokenVariable[account];
    const token = environment[variable];
    if (token === undefined || token === "") {
      return { ok: false, reason: text("command.reason.noToken", { variable, account }) };
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
