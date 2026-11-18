import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProcessRunner } from "./git.js";

export const tokenVariable = "SUPERAGENT2_GITHUB_AUTH";

export const credentialHelper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${tokenVariable}"; }; f`;

export function gitConfigParameters(shared = false): string {
  const entries = ["credential.helper=", `credential.https://github.com.helper=${credentialHelper}`];
  if (shared) {
    entries.push("core.hooksPath=/dev/null", "push.autoSetupRemote=false");
    const github = "https://github.com/";
    for (const prefix of ["git@github.com:", "ssh://git@github.com/", "git+ssh://git@github.com/", "ssh://git@ssh.github.com:443/", "git://github.com/", "http://github.com/"]) {
      entries.push(`url.${github}.insteadOf=${prefix}`);
    }
  }
  return entries.map((entry) => `'${entry.replaceAll("'", "'\\''")}'`).join(" ");
}

export function shimFolder(home: string): string {
  return join(home, "bin");
}

export function writeGhShims(folder: string, gh: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(folder, { recursive: true });
  if (platform === "win32") {
    writeFileSync(
      join(folder, "gh.cmd"),
      ["@echo off", `if not defined GH_TOKEN set "GH_TOKEN=%${tokenVariable}%"`, `"${gh}" %*`, ""].join("\r\n"),
    );
    return;
  }
  const file = join(folder, "gh");
  writeFileSync(
    file,
    ["#!/bin/sh", `if [ -z "\${GH_TOKEN:-}" ]; then GH_TOKEN="\${${tokenVariable}:-}"; export GH_TOKEN; fi`, `exec '${gh.replaceAll("'", "'\\''")}' "$@"`, ""].join("\n"),
  );
  chmodSync(file, 0o755);
}

const inheritedCredential =
  /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|SUPERAGENT2_GITHUB_AUTH|RUNNER_TOKEN|ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)$/i;

export function withoutCredentials(environment: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !inheritedCredential.test(name)));
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

function pathOf(environment: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
}

export function workerEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  token: string,
  shims: string,
  identity: Identity | undefined,
  platform: NodeJS.Platform = process.platform,
  shared = false,
): Record<string, string> {
  const separator = platform === "win32" ? ";" : ":";
  const path = pathOf(base);
  return {
    PATH: path === "" ? shims : `${shims}${separator}${path}`,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    [tokenVariable]: token,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_PARAMETERS: gitConfigParameters(shared),
    ...(identity === undefined
      ? {}
      : { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }),
  };
}

const GitHubUser = z.looseObject({ login: z.string().min(1), id: z.number().int(), name: z.string().nullable().optional() });

export async function readIdentity(run: ProcessRunner, gh: string, environment: Readonly<Record<string, string>>, cwd: string): Promise<Identity | undefined> {
  const result = await run(gh, ["api", "user"], { cwd, env: environment });
  if (result.code !== 0) {
    return undefined;
  }
  try {
    const user = GitHubUser.parse(JSON.parse(result.stdout));
    return { name: user.name ?? user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  } catch {
    return undefined;
  }
}
