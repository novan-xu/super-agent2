import { parseArgs } from "node:util";
import { encodeRunnerSetup, MachineName, MachineSystem, RepositoryName, Revision } from "@super-agent2/protocol";
import { type Clock, systemClock } from "./clock.js";
import { type AccessServiceTokens, cloudflareServiceTokens, cloudflareSettings } from "./cloudflare.js";
import { openDatabase } from "./database.js";
import { type AddOutcome, createMachineAdmin, type RevokeOutcome } from "./machine-admin.js";
import { createMachineStore, MachineError, type Machine, type MachineStore } from "./machines.js";

export interface MachineCommandOptions {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly clock?: Clock;
  readonly serviceTokens?: AccessServiceTokens;
}

export const machineCommandUsage = [
  "Usage: node packages/hub/dist/machines-cli.js <command>",
  "  add <name> --system <windows|macos> [--hub <url>]",
  "      Add a work machine as 添加机器 in 设置 does: create its Access service token through Cloudflare's API",
  "      with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ACCESS_API_TOKEN, and its runner token, and print, once, the",
  "      install line to run on that machine. The hub's address is --hub or HUB_PUBLIC_URL; the version it installs",
  "      is SUPERAGENT2_REVISION of HUB_SOURCE_REPOSITORY.",
  "  add <name> --access-client-id <id> [--hub <url>]",
  "      Add a work machine with an existing service token and print, once, the line its runner's setup asks for.",
  "  revoke <name>",
  "      Refuse the machine's runner from now on, close its open connection and delete the service token the hub made.",
  "  list",
  "      List the machines.",
  "HUB_DATA_DIR names the hub's data folder.",
];

export const missingCloudflare =
  "The hub has no Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ACCESS_API_TOKEN), so it cannot make an access token for a new machine; nothing was added";

export const missingRelease =
  "The hub does not know the version it runs (SUPERAGENT2_REVISION and HUB_SOURCE_REPOSITORY), so a new machine would have nothing to install; nothing was added";

const systemNames: Readonly<Record<MachineSystem, string>> = { windows: "Windows PowerShell", macos: "the macOS terminal" };

function when(time: number | null): string {
  return time === null ? "never" : new Date(time).toISOString();
}

function describe(machine: Machine): string {
  const state = machine.revokedAt === null ? "active" : `revoked ${when(machine.revokedAt)}`;
  const reported = machine.report === null ? "" : ` ${machine.report.platform} ${machine.report.hostname}`;
  const system = machine.system === null ? "" : `\t${machine.system}`;
  const expiry = machine.accessExpiresAt === null ? "" : `\ttoken runs out ${when(machine.accessExpiresAt)}`;
  return `${machine.name}\t${state}${system}\taccess client ${machine.accessClientId}${expiry}\tadded ${when(machine.createdAt)}\tlast seen ${when(machine.lastSeenAt)}${reported}`;
}

function hubUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function serviceTokens(options: MachineCommandOptions): AccessServiceTokens | undefined {
  if (options.serviceTokens !== undefined) {
    return options.serviceTokens;
  }
  const settings = cloudflareSettings(options.environment);
  return "missing" in settings ? undefined : cloudflareServiceTokens(settings);
}

function releaseVersion(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const version = Revision.safeParse(environment["SUPERAGENT2_REVISION"]);
  const source = RepositoryName.safeParse(environment["HUB_SOURCE_REPOSITORY"]);
  return version.success && source.success ? version.data : undefined;
}

function admin(options: MachineCommandOptions, machines: MachineStore, clock: Clock) {
  return createMachineAdmin({
    clock,
    machines,
    revoke: (name) => {
      machines.revoke(name);
    },
    tokens: serviceTokens(options),
    version: releaseVersion(options.environment),
  });
}

function refusal(outcome: Exclude<AddOutcome, { readonly ok: true }>, name: string): string {
  switch (outcome.error) {
    case "cloudflare":
      return missingCloudflare;
    case "release":
      return missingRelease;
    case "conflict":
      return `A machine named ${name} already exists; revoke it first`;
    case "bad_request":
      return "The hub's address must be an http or https origin such as https://agent.example.com";
    case "cloudflare_refused":
      return `Cloudflare did not make the access token, so nothing was added: ${outcome.reason}`;
  }
}

function revoked(outcome: Extract<RevokeOutcome, { readonly ok: true }>, name: string): string {
  const closed = "Its runner is refused from now on; a running hub closes its open connection within a few seconds.";
  switch (outcome.accessToken) {
    case "removed":
      return `Revoked ${name} and deleted its Access service token at Cloudflare. ${closed}`;
    case "kept":
      return `Revoked ${name}, but its Access service token could not be deleted and is still at Cloudflare; delete superagent2-runner-${name} there by hand. ${closed}`;
    case "none":
      return `Revoked ${name}; its Access service token was not made by the hub and stays at Cloudflare. ${closed}`;
  }
}

function addReusing(options: MachineCommandOptions, machines: MachineStore, name: string, hub: string, accessClientId: string): number {
  const added = machines.add({ name, accessClientId });
  options.out(`Added the machine ${added.machine.name}, with the Access client ${accessClientId}.`);
  options.out(`On ${added.machine.name}, run the runner's setup and paste this line when it asks. It is shown only this once:`);
  options.out(encodeRunnerSetup({ hub, name: added.machine.name, accessClientId, runnerToken: added.token }));
  options.out(`The setup then asks for the client secret of the Access service token ${accessClientId}.`);
  return 0;
}

export async function runMachineCommand(options: MachineCommandOptions): Promise<number> {
  const { out, err } = options;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...options.argv],
      allowPositionals: true,
      options: { hub: { type: "string" }, system: { type: "string" }, "access-client-id": { type: "string" }, help: { type: "boolean", short: "h" } },
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    machineCommandUsage.forEach(err);
    return 2;
  }
  const [command, name, ...rest] = parsed.positionals;
  if (parsed.values.help === true || command === undefined) {
    machineCommandUsage.forEach(out);
    return command === undefined && parsed.values.help !== true ? 2 : 0;
  }
  const expected = command === "list" ? 0 : 1;
  if ((command !== "add" && command !== "revoke" && command !== "list") || (expected === 1 && name === undefined) || rest.length > 0 || (expected === 0 && name !== undefined)) {
    machineCommandUsage.forEach(err);
    return 2;
  }
  const dataDir = options.environment["HUB_DATA_DIR"] ?? "";
  if (dataDir === "") {
    err("HUB_DATA_DIR is required");
    return 2;
  }
  const clock = options.clock ?? systemClock;
  if (command === "add") {
    const machineName = MachineName.safeParse(name);
    if (!machineName.success) {
      err(`${String(name)} is not a machine name: use lower-case letters, digits and dashes, not hub or nas`);
      return 2;
    }
    const reused = parsed.values["access-client-id"];
    const system = parsed.values.system === undefined ? undefined : MachineSystem.safeParse(parsed.values.system);
    if ((reused === undefined) === (system === undefined) || (system !== undefined && !system.success)) {
      err("Give --system windows or --system macos for a new machine, or --access-client-id <id> to reuse a service token");
      return 2;
    }
    const hub = hubUrl(parsed.values.hub ?? options.environment["HUB_PUBLIC_URL"]);
    if (hub === undefined) {
      err("The hub's address is required as --hub <url> or HUB_PUBLIC_URL, for example https://agent.example.com");
      return 2;
    }
    const database = openDatabase({ dataDir, clock });
    try {
      const machines = createMachineStore(database, clock);
      if (reused !== undefined) {
        if (machines.active(machineName.data) !== undefined) {
          err(`A machine named ${machineName.data} already exists; revoke it first`);
          return 1;
        }
        return addReusing(options, machines, machineName.data, hub, reused);
      }
      if (system === undefined || !system.success) {
        return 2;
      }
      const outcome = await admin(options, machines, clock).add({ name: machineName.data, system: system.data, hub });
      if (!outcome.ok) {
        err(refusal(outcome, machineName.data));
        return outcome.error === "cloudflare" || outcome.error === "release" || outcome.error === "bad_request" ? 2 : 1;
      }
      out(`Added the machine ${outcome.name}. Run this line once in ${systemNames[outcome.system]} on ${outcome.name}; it holds the machine's credentials and is shown only this once:`);
      out(outcome.command);
      return 0;
    } catch (error) {
      err(error instanceof MachineError || error instanceof Error ? error.message : String(error));
      return 1;
    } finally {
      database.close();
    }
  }
  const database = openDatabase({ dataDir, clock });
  try {
    const machines = createMachineStore(database, clock);
    if (command === "list") {
      const all = machines.list();
      if (all.length === 0) {
        out("No machines.");
      }
      all.map(describe).forEach(out);
      return 0;
    }
    const machineName = String(name);
    const outcome = await admin(options, machines, clock).revoke(machineName);
    if (!outcome.ok) {
      err(`There is no active machine named ${machineName}`);
      return 1;
    }
    out(revoked(outcome, machineName));
    return 0;
  } finally {
    database.close();
  }
}
