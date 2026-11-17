import { parseArgs } from "node:util";
import { encodeRunnerSetup, MachineName } from "@super-agent2/protocol";
import { type Clock, systemClock } from "./clock.js";
import { type AccessServiceTokens, cloudflareServiceTokens, cloudflareSettings } from "./cloudflare.js";
import { openDatabase } from "./database.js";
import { createMachineStore, MachineError, type Machine } from "./machines.js";

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
  "  add <name> [--hub <url>] [--access-client-id <id>]",
  "      Add a work machine and print, once, the line its runner's setup asks for.",
  "      Without --access-client-id a new Access service token is created through Cloudflare's API",
  "      with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ACCESS_API_TOKEN. The hub's address is --hub or HUB_PUBLIC_URL.",
  "  revoke <name>",
  "      Refuse the machine's runner from now on and close its open connection.",
  "  list",
  "      List the machines.",
  "HUB_DATA_DIR names the hub's data folder.",
];

function when(time: number | null): string {
  return time === null ? "never" : new Date(time).toISOString();
}

function describe(machine: Machine): string {
  const state = machine.revokedAt === null ? "active" : `revoked ${when(machine.revokedAt)}`;
  const system = machine.report === null ? "" : ` ${machine.report.platform} ${machine.report.hostname}`;
  return `${machine.name}\t${state}\taccess client ${machine.accessClientId}\tadded ${when(machine.createdAt)}\tlast seen ${when(machine.lastSeenAt)}${system}`;
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

export async function runMachineCommand(options: MachineCommandOptions): Promise<number> {
  const { out, err } = options;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...options.argv],
      allowPositionals: true,
      options: { hub: { type: "string" }, "access-client-id": { type: "string" }, help: { type: "boolean", short: "h" } },
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
    const hub = hubUrl(parsed.values.hub ?? options.environment["HUB_PUBLIC_URL"]);
    if (hub === undefined) {
      err("The hub's address is required as --hub <url> or HUB_PUBLIC_URL, for example https://agent.example.com");
      return 2;
    }
    const database = openDatabase({ dataDir, clock });
    try {
      const machines = createMachineStore(database, clock);
      if (machines.active(machineName.data) !== undefined) {
        err(`A machine named ${machineName.data} already exists; revoke it first`);
        return 1;
      }
      const reused = parsed.values["access-client-id"];
      let accessClientId: string;
      let accessClientSecret: string | undefined;
      let accessTokenId: string | undefined;
      if (reused === undefined) {
        let tokens = options.serviceTokens;
        if (tokens === undefined) {
          const settings = cloudflareSettings(options.environment);
          if ("missing" in settings) {
            err(`${settings.missing.join(" and ")} must be set to create an Access service token, or give --access-client-id`);
            return 2;
          }
          tokens = cloudflareServiceTokens(settings);
        }
        const created = await tokens.create(`superagent2-runner-${machineName.data}`);
        accessClientId = created.clientId;
        accessClientSecret = created.clientSecret;
        accessTokenId = created.id;
      } else {
        accessClientId = reused;
      }
      const added = machines.add({
        name: machineName.data,
        accessClientId,
        ...(accessTokenId === undefined ? {} : { accessTokenId }),
      });
      out(`Added the machine ${added.machine.name}, with the Access client ${accessClientId}.`);
      out(`On ${added.machine.name}, run the runner's setup and paste this line when it asks. It is shown only this once:`);
      out(
        encodeRunnerSetup({
          hub,
          name: added.machine.name,
          accessClientId,
          ...(accessClientSecret === undefined ? {} : { accessClientSecret }),
          runnerToken: added.token,
        }),
      );
      if (accessClientSecret === undefined) {
        out(`The setup then asks for the client secret of the Access service token ${accessClientId}.`);
      }
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
    if (machines.active(machineName) === undefined) {
      err(`There is no active machine named ${machineName}`);
      return 1;
    }
    machines.revoke(machineName);
    out(`Revoked ${machineName}. Its runner is refused from now on; a running hub closes its open connection within a few seconds.`);
    return 0;
  } finally {
    database.close();
  }
}
