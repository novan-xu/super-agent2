import { createHash, randomBytes } from "node:crypto";
import {
  accessClientIdHeader,
  accessClientSecretHeader,
  type AccessTokenOutcome,
  encodeRunnerSetup,
  enrollPath,
  type Enrollment,
  installCodeHeader,
  installCodeLifetime,
  installCodePattern,
  MachineName,
  MachineSystem,
  runnerReleasePath,
  runnerTokenHeader,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { AccessServiceTokens } from "./cloudflare.js";
import type { HubDatabase } from "./database.js";
import type { MachineStore } from "./machines.js";

export interface IssuedCode {
  readonly code: string;
  readonly expiresAt: number;
}

export interface Claim {
  readonly name: string;
  readonly system: MachineSystem;
  readonly hub: string;
}

export interface InstallCodes {
  issue(request: Claim): IssuedCode;
  claim(code: string): Claim | undefined;
  release(code: string): void;
  finish(code: string): void;
  pending(): Enrollment[];
  forget(name: string): void;
}

const CodeRow = z.object({ name: MachineName, system: MachineSystem, hub: z.string(), expires_at: z.number().int() });

export function installCodeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function createInstallCodes(database: HubDatabase, clock: Clock): InstallCodes {
  const { connection } = database;
  const removeExpired = connection.prepare("DELETE FROM install_codes WHERE expires_at <= ?");
  const removeName = connection.prepare("DELETE FROM install_codes WHERE name = ?");
  const insert = connection.prepare("INSERT INTO install_codes (name, system, code_hash, hub, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const claimRow = connection.prepare(
    "UPDATE install_codes SET claimed_at = ? WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ? RETURNING name, system, hub, expires_at",
  );
  const unclaim = connection.prepare("UPDATE install_codes SET claimed_at = NULL WHERE code_hash = ?");
  const removeCode = connection.prepare("DELETE FROM install_codes WHERE code_hash = ?");
  const selectPending = connection.prepare("SELECT name, system, hub, expires_at FROM install_codes WHERE claimed_at IS NULL AND expires_at > ? ORDER BY name");
  return {
    issue: (request) => {
      const now = clock.now();
      removeExpired.run(now);
      removeName.run(request.name);
      const code = randomBytes(32).toString("base64url");
      const expiresAt = now + installCodeLifetime;
      insert.run(request.name, request.system, installCodeHash(code), request.hub, now, expiresAt);
      return { code, expiresAt };
    },
    claim: (code) => {
      if (!installCodePattern.test(code)) {
        return undefined;
      }
      const row = claimRow.get(clock.now(), installCodeHash(code), clock.now());
      if (row === undefined) {
        return undefined;
      }
      const value = CodeRow.parse(row);
      return { name: value.name, system: value.system, hub: value.hub };
    },
    release: (code) => {
      unclaim.run(installCodeHash(code));
    },
    finish: (code) => {
      removeCode.run(installCodeHash(code));
    },
    pending: () => selectPending.all(clock.now()).map((row) => {
      const value = CodeRow.parse(row);
      return { name: value.name, system: value.system, expiresAt: value.expires_at };
    }),
    forget: (name) => {
      removeName.run(name);
    },
  };
}

function enrollUrl(hub: string): string {
  return new URL(enrollPath, hub).toString();
}

export function installCommand(system: MachineSystem, hub: string, code: string): string {
  const url = enrollUrl(hub);
  if (system === "windows") {
    return `powershell -NoProfile -Command "irm -Method Post -MaximumRedirection 0 -Headers @{'${installCodeHeader}'='${code}'} -Uri '${url}' | iex"`;
  }
  return `/bin/sh -c "$(curl -fsS -X POST -H '${installCodeHeader}: ${code}' '${url}')"`;
}

export interface ScriptValues {
  readonly hub: string;
  readonly version: string;
  readonly setup: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly runnerToken: string;
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
    `release='${release}'`,
    `version='${values.version}'`,
    `setup='${values.setup}'`,
    `client_id='${values.clientId}'`,
    `client_secret='${values.clientSecret}'`,
    `runner_token='${values.runnerToken}'`,
    'fail() { echo "$1" >&2; exit 1; }',
    'command -v node >/dev/null 2>&1 || fail "Node.js 24 or later is needed"',
    'major=$(node -p "process.versions.node.split(\'.\')[0]")',
    '[ "$major" -ge 24 ] || fail "Node.js 24 or later is needed; this is $(node -v)"',
    'command -v pnpm >/dev/null 2>&1 || fail "pnpm is needed"',
    'home="${SUPERAGENT2_RUNNER_HOME:-$HOME/.superagent2}"',
    'folder="$home/versions/$(printf %s "$version" | cut -c1-12)"',
    'rm -rf "$folder"',
    'mkdir -p "$folder"',
    'echo "Fetching the runner from the hub"',
    `curl -fsS -H "${accessClientIdHeader}: $client_id" -H "${accessClientSecretHeader}: $client_secret" -H "${runnerTokenHeader}: $runner_token" "$release" -o "$folder.tar.gz"`,
    'tar -xzf "$folder.tar.gz" -C "$folder" --strip-components=1',
    'rm -f "$folder.tar.gz"',
    'printf "%s\\n" "$version" > "$folder/.revision"',
    'echo "Installing and building the runner in $folder"',
    `(cd "$folder" && CI=true pnpm install --frozen-lockfile >/dev/null && CI=true pnpm --filter-prod "${runnerFilter}" run build >/dev/null)`,
    'main="$folder/packages/runner/dist/main.js"',
    'printf "%s\\n" "$setup" | node "$main" setup',
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
    `$release = '${release}'`,
    `$version = '${values.version}'`,
    `$setup = '${values.setup}'`,
    `$headers = @{ '${accessClientIdHeader}' = '${values.clientId}'; '${accessClientSecretHeader}' = '${values.clientSecret}'; '${runnerTokenHeader}' = '${values.runnerToken}' }`,
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
    "Invoke-WebRequest -UseBasicParsing -Uri $release -Headers $headers -OutFile $archive",
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
    "$setup | & node $main setup",
    "if ($LASTEXITCODE -ne 0) { throw 'Saving the runner settings failed' }",
    "if ($env:SUPERAGENT2_RUNNER_FOREGROUND -eq '1') { & node $main run } else { & node $main install }",
    "}",
    "",
  ].join("\r\n");
}

export type AddOutcome =
  | { readonly ok: true; readonly name: string; readonly system: MachineSystem; readonly command: string; readonly expiresAt: number }
  | { readonly ok: false; readonly error: "cloudflare" | "release" | "conflict" | "bad_request" };

export type RedeemOutcome =
  | { readonly ok: true; readonly script: string }
  | { readonly ok: false; readonly error: "refused" | "unavailable" };

export type RevokeOutcome = { readonly ok: true; readonly accessToken: AccessTokenOutcome } | { readonly ok: false; readonly error: "not_found" };

export interface MachineAdmin {
  readonly canAdd: { readonly cloudflare: boolean; readonly release: boolean };
  add(request: { readonly name: string; readonly system: MachineSystem; readonly hub: string }): AddOutcome;
  redeem(code: string): Promise<RedeemOutcome>;
  revoke(name: string): Promise<RevokeOutcome>;
  pending(): Enrollment[];
}

export interface MachineAdminOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly machines: MachineStore;
  readonly revoke: (name: string) => void;
  readonly tokens: AccessServiceTokens | undefined;
  readonly version: string | undefined;
  readonly report?: (line: string) => void;
  readonly changed?: () => void;
}

export function serviceTokenName(machine: string): string {
  return `superagent2-runner-${machine}`;
}

export function createMachineAdmin(options: MachineAdminOptions): MachineAdmin {
  const codes = createInstallCodes(options.database, options.clock);
  const { machines, tokens, version } = options;
  const report = options.report ?? (() => undefined);
  const changed = () => options.changed?.();
  return {
    canAdd: { cloudflare: tokens !== undefined, release: version !== undefined },
    add: (request) => {
      if (tokens === undefined) {
        return { ok: false, error: "cloudflare" };
      }
      if (version === undefined) {
        return { ok: false, error: "release" };
      }
      const name = MachineName.safeParse(request.name);
      if (!name.success) {
        return { ok: false, error: "bad_request" };
      }
      if (machines.active(name.data) !== undefined) {
        return { ok: false, error: "conflict" };
      }
      const issued = codes.issue({ name: name.data, system: request.system, hub: request.hub });
      changed();
      return { ok: true, name: name.data, system: request.system, command: installCommand(request.system, request.hub, issued.code), expiresAt: issued.expiresAt };
    },
    redeem: async (code) => {
      if (tokens === undefined || version === undefined) {
        return { ok: false, error: "refused" };
      }
      const claim = codes.claim(code);
      if (claim === undefined) {
        return { ok: false, error: "refused" };
      }
      if (machines.active(claim.name) !== undefined) {
        codes.finish(code);
        changed();
        return { ok: false, error: "refused" };
      }
      let created;
      try {
        created = await tokens.create(serviceTokenName(claim.name));
      } catch (error) {
        codes.release(code);
        report(`Adding the machine ${claim.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, error: "unavailable" };
      }
      let added;
      try {
        added = machines.add({ name: claim.name, accessClientId: created.clientId, accessTokenId: created.id });
      } catch (error) {
        codes.finish(code);
        changed();
        report(`Adding the machine ${claim.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        await tokens.remove(created.id).catch(() => undefined);
        return { ok: false, error: "refused" };
      }
      codes.finish(code);
      changed();
      const setup = encodeRunnerSetup({ hub: claim.hub, name: claim.name, accessClientId: created.clientId, accessClientSecret: created.clientSecret, runnerToken: added.token });
      const values = { hub: claim.hub, version, setup, clientId: created.clientId, clientSecret: created.clientSecret, runnerToken: added.token };
      return { ok: true, script: claim.system === "windows" ? windowsScript(values) : macosScript(values) };
    },
    revoke: async (name) => {
      const machine = machines.active(name);
      if (machine === undefined) {
        return { ok: false, error: "not_found" };
      }
      options.revoke(name);
      codes.forget(name);
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
        report(`The Access service token of ${name} was kept: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: true, accessToken: "kept" };
      }
    },
    pending: () => codes.pending(),
  };
}
