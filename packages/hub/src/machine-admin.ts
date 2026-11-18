import { text } from "@super-agent2/catalog";
import {
  accessClientIdHeader,
  accessClientSecretHeader,
  type AccessTokenOutcome,
  encodeRunnerSetup,
  machineAccessWarning,
  MachineName,
  MachineSystem,
  refusalReasonLength,
  runnerInstallPath,
  runnerReleasePath,
  runnerTokenHeader,
} from "@super-agent2/protocol";
import type { Clock } from "./clock.js";
import type { AccessServiceTokens } from "./cloudflare.js";
import { MachineError, type Machine, type MachineStore } from "./machines.js";

export interface LineValues {
  readonly hub: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly runnerToken: string;
}

const lineCredential = /^[A-Za-z0-9._-]+$/;
const lineAddress = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

export function lineAddressProblem(hub: string): boolean {
  return !lineAddress.test(hub);
}

export function lineCredentialProblem(...values: readonly string[]): boolean {
  return !values.every((value) => lineCredential.test(value));
}

function checkedLine(values: LineValues): LineValues {
  if (lineAddressProblem(values.hub) || lineCredentialProblem(values.clientId, values.clientSecret, values.runnerToken)) {
    throw new Error("A value of the install line has a character the line cannot carry");
  }
  return values;
}

export function installCommand(system: MachineSystem, given: LineValues): string {
  const values = checkedLine(given);
  const url = new URL(runnerInstallPath, values.hub).toString();
  if (system === "windows") {
    return `& { $access = @{ '${accessClientIdHeader}' = '${values.clientId}'; '${accessClientSecretHeader}' = '${values.clientSecret}'; '${runnerTokenHeader}' = '${values.runnerToken}' }; irm -MaximumRedirection 0 -Headers $access -Uri '${url}' | iex }`;
  }
  return `( id='${values.clientId}'; secret='${values.clientSecret}'; token='${values.runnerToken}'; script="$(printf '${accessClientIdHeader}: %s\\n${accessClientSecretHeader}: %s\\n${runnerTokenHeader}: %s\\n' "$id" "$secret" "$token" | curl -fsSL --max-redirs 0 -H @- '${url}')" && printf '%s\\n%s\\n%s\\n' "$id" "$secret" "$token" | /bin/sh -c "$script" )`;
}

export interface ScriptValues {
  readonly hub: string;
  readonly version: string;
  readonly setup: string;
}

const safeValue = /^[A-Za-z0-9._:/@+=-]+$/;

function checked(values: ScriptValues): ScriptValues {
  for (const value of Object.values(values)) {
    if (!safeValue.test(value)) {
      throw new Error("A value of the install script has a character the script cannot carry");
    }
  }
  return values;
}

const runnerFilter = "@super-agent2/runner...";

export function macosScript(given: ScriptValues): string {
  const values = checked(given);
  const release = new URL(runnerReleasePath, values.hub).toString();
  return [
    "set -eu",
    'fail() { echo "$1" >&2; exit 1; }',
    'IFS= read -r client_id || fail "Run the install line the hub showed; it gives this script the machine\'s credentials"',
    'IFS= read -r client_secret || fail "The install line gave no client secret"',
    'IFS= read -r runner_token || fail "The install line gave no runner token"',
    `release='${release}'`,
    `version='${values.version}'`,
    `setup='${values.setup}'`,
    `credentials() { printf '${accessClientIdHeader}: %s\\n${accessClientSecretHeader}: %s\\n${runnerTokenHeader}: %s\\n' "$client_id" "$client_secret" "$runner_token"; }`,
    'command -v node >/dev/null 2>&1 || fail "Node.js 24 or later is needed"',
    'major=$(node -p "process.versions.node.split(\'.\')[0]")',
    '[ "$major" -ge 24 ] || fail "Node.js 24 or later is needed; this is $(node -v)"',
    'command -v pnpm >/dev/null 2>&1 || fail "pnpm is needed"',
    'home="${SUPERAGENT2_RUNNER_HOME:-$HOME/.superagent2}"',
    'folder="$home/versions/$(printf %s "$version" | cut -c1-12)"',
    'rm -rf "$folder"',
    'mkdir -p "$folder"',
    'echo "Fetching the runner from the hub"',
    'credentials | curl -fsS -H @- "$release" -o "$folder.tar.gz"',
    'tar -xzf "$folder.tar.gz" -C "$folder" --strip-components=1',
    'rm -f "$folder.tar.gz"',
    'printf "%s\\n" "$version" > "$folder/.revision"',
    'echo "Installing and building the runner in $folder"',
    `(cd "$folder" && CI=true pnpm install --frozen-lockfile >/dev/null && CI=true pnpm --filter-prod "${runnerFilter}" run build >/dev/null)`,
    'main="$folder/packages/runner/dist/main.js"',
    'printf "%s\\n%s\\n%s\\n" "$setup" "$client_secret" "$runner_token" | node "$main" setup',
    'if [ "${SUPERAGENT2_RUNNER_FOREGROUND:-}" = "1" ]; then exec node "$main" run; fi',
    'node "$main" install',
    "",
  ].join("\n");
}

export function windowsScript(given: ScriptValues): string {
  const values = checked(given);
  const release = new URL(runnerReleasePath, values.hub).toString();
  return [
    "& {",
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "if (-not ($access -is [hashtable])) { throw 'Run the install line the hub showed; it gives this script the machine''s credentials' }",
    `$release = '${release}'`,
    `$version = '${values.version}'`,
    `$setup = '${values.setup}'`,
    "if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or later is needed' }",
    "$major = [int](& node -p \"process.versions.node.split('.')[0]\")",
    "if ($major -lt 24) { throw \"Node.js 24 or later is needed; this is $(& node -v)\" }",
    "if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is needed' }",
    "$runnerHome = if ($env:SUPERAGENT2_RUNNER_HOME) { $env:SUPERAGENT2_RUNNER_HOME } else { Join-Path $env:USERPROFILE '.superagent2' }",
    "$folder = Join-Path (Join-Path $runnerHome 'versions') $version.Substring(0, 12)",
    "if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }",
    "New-Item -ItemType Directory -Force $folder | Out-Null",
    "$archive = \"$folder.tar.gz\"",
    "Write-Host 'Fetching the runner from the hub'",
    "Invoke-WebRequest -UseBasicParsing -Uri $release -Headers $access -OutFile $archive",
    "& (Join-Path $env:SystemRoot 'System32\\tar.exe') -xzf $archive -C $folder --strip-components=1",
    "if ($LASTEXITCODE -ne 0) { throw 'Unpacking the runner failed' }",
    "Remove-Item -Force $archive",
    "Set-Content -Encoding ascii -Path (Join-Path $folder '.revision') -Value $version",
    "Write-Host \"Installing and building the runner in $folder\"",
    "$env:CI = 'true'",
    "Push-Location $folder",
    "try {",
    "  & pnpm install --frozen-lockfile | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }",
    `  & pnpm --filter-prod '${runnerFilter}' run build | Out-Null`,
    "  if ($LASTEXITCODE -ne 0) { throw 'Building the runner failed' }",
    "} finally { Pop-Location }",
    "$main = Join-Path $folder 'packages\\runner\\dist\\main.js'",
    `@($setup, $access['${accessClientSecretHeader}'], $access['${runnerTokenHeader}']) | & node $main setup`,
    "if ($LASTEXITCODE -ne 0) { throw 'Saving the runner settings failed' }",
    "if ($env:SUPERAGENT2_RUNNER_FOREGROUND -eq '1') { & node $main run } else { & node $main install }",
    "}",
    "",
  ].join("\r\n");
}

export type AddOutcome =
  | { readonly ok: true; readonly name: string; readonly system: MachineSystem; readonly command: string }
  | { readonly ok: false; readonly error: "cloudflare" | "release" | "conflict" | "bad_request" }
  | { readonly ok: false; readonly error: "cloudflare_refused"; readonly reason: string };

export type InstallOutcome = { readonly ok: true; readonly script: string } | { readonly ok: false; readonly error: "not_found" | "unavailable" };

export type RevokeOutcome = { readonly ok: true; readonly accessToken: AccessTokenOutcome } | { readonly ok: false; readonly error: "not_found" };

export interface MachineAdmin {
  readonly canAdd: { readonly cloudflare: boolean; readonly release: boolean };
  add(request: { readonly name: string; readonly system: MachineSystem; readonly hub: string }): Promise<AddOutcome>;
  install(machine: Machine): InstallOutcome;
  revoke(name: string): Promise<RevokeOutcome>;
  warnExpiring(): void;
}

export interface MachineAdminOptions {
  readonly clock: Clock;
  readonly machines: MachineStore;
  readonly revoke: (name: string) => void;
  readonly tokens: AccessServiceTokens | undefined;
  readonly version: string | undefined;
  readonly report?: (line: string) => void;
  readonly changed?: () => void;
  readonly tell?: (notice: string, prompt: string) => void;
}

export function serviceTokenName(machine: string): string {
  return `superagent2-runner-${machine}`;
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > refusalReasonLength ? `${message.slice(0, refusalReasonLength - 1)}…` : message;
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function createMachineAdmin(options: MachineAdminOptions): MachineAdmin {
  const { machines, tokens, version, clock } = options;
  const report = options.report ?? (() => undefined);
  const changed = () => options.changed?.();
  const adding = new Set<string>();

  const add: MachineAdmin["add"] = async (request) => {
    if (tokens === undefined) {
      return { ok: false, error: "cloudflare" };
    }
    if (version === undefined) {
      return { ok: false, error: "release" };
    }
    const name = MachineName.safeParse(request.name);
    const system = MachineSystem.safeParse(request.system);
    if (!name.success || !system.success || lineAddressProblem(request.hub)) {
      return { ok: false, error: "bad_request" };
    }
    if (machines.active(name.data) !== undefined || adding.has(name.data)) {
      return { ok: false, error: "conflict" };
    }
    adding.add(name.data);
    try {
      let created;
      try {
        created = await tokens.create(serviceTokenName(name.data));
      } catch (error) {
        report(`Adding the machine ${name.data} failed: ${reasonOf(error)}`);
        return { ok: false, error: "cloudflare_refused", reason: reasonOf(error) };
      }
      if (lineCredentialProblem(created.clientId, created.clientSecret)) {
        await tokens.remove(created.id).catch(() => undefined);
        const reason = "The service token Cloudflare made has a character the install line cannot carry, so it was deleted again";
        report(`Adding the machine ${name.data} failed: ${reason}`);
        return { ok: false, error: "cloudflare_refused", reason };
      }
      let added;
      try {
        added = machines.add({ name: name.data, accessClientId: created.clientId, accessTokenId: created.id, accessExpiresAt: created.expiresAt, system: system.data, hub: request.hub });
      } catch (error) {
        await tokens.remove(created.id).catch(() => undefined);
        if (error instanceof MachineError) {
          return { ok: false, error: "conflict" };
        }
        throw error;
      }
      changed();
      const command = installCommand(system.data, { hub: request.hub, clientId: created.clientId, clientSecret: created.clientSecret, runnerToken: added.token });
      return { ok: true, name: name.data, system: system.data, command };
    } finally {
      adding.delete(name.data);
    }
  };

  const install: MachineAdmin["install"] = (machine) => {
    if (machine.system === null || machine.hub === null) {
      return { ok: false, error: "not_found" };
    }
    if (version === undefined) {
      return { ok: false, error: "unavailable" };
    }
    const setup = encodeRunnerSetup({ hub: machine.hub, name: machine.name, accessClientId: machine.accessClientId });
    const values = { hub: machine.hub, version, setup };
    return { ok: true, script: machine.system === "windows" ? windowsScript(values) : macosScript(values) };
  };

  const revoke: MachineAdmin["revoke"] = async (name) => {
    const machine = machines.active(name);
    if (machine === undefined) {
      return { ok: false, error: "not_found" };
    }
    options.revoke(name);
    changed();
    if (machine.accessTokenId === null) {
      return { ok: true, accessToken: "none" };
    }
    if (tokens === undefined) {
      return { ok: true, accessToken: "kept" };
    }
    try {
      await tokens.remove(machine.accessTokenId);
      return { ok: true, accessToken: "removed" };
    } catch (error) {
      report(`The Access service token of ${name} was kept: ${reasonOf(error)}`);
      return { ok: true, accessToken: "kept" };
    }
  };

  const warnExpiring = () => {
    const now = clock.now();
    for (const machine of machines.list()) {
      if (machine.revokedAt !== null || machine.accessExpiresAt === null || machine.accessWarnedAt !== null || machine.accessExpiresAt - now > machineAccessWarning) {
        continue;
      }
      machines.warned(machine.name);
      const day = dayOf(machine.accessExpiresAt);
      const gone = machine.accessExpiresAt <= now;
      options.tell?.(
        text(gone ? "notice.machineAccessExpired" : "notice.machineAccessExpiring", { name: machine.name, day }),
        [
          `[hub] The Cloudflare Access service token of the machine ${machine.name} ${gone ? "ran out" : "runs out"} on ${day} (UTC). Once it has run out, Cloudflare refuses that machine's runner and the machine shows as offline in 设置.`,
          "Tell the owner. The fix is the owner's: revoke the machine in 设置 › 机器, add it again under the same name, and run the new install line on that machine; the new token does not expire. Refreshing the token in Cloudflare's dashboard also works, but the hub would keep showing the old date.",
        ].join("\n"),
      );
      changed();
    }
  };

  return {
    canAdd: { cloudflare: tokens !== undefined, release: version !== undefined },
    add,
    install,
    revoke,
    warnExpiring,
  };
}
