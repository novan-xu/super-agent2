import { createHash, randomBytes } from "node:crypto";
import { MachineName, MachineReport, MachineSystem, StorageSettings } from "@super-agent2/protocol";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";

export interface Machine {
  readonly name: string;
  readonly tokenHash: string;
  readonly accessClientId: string;
  readonly accessTokenId: string | null;
  readonly accessExpiresAt: number | null;
  readonly accessWarnedAt: number | null;
  readonly system: MachineSystem | null;
  readonly hub: string | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
  readonly report: MachineReport | null;
  readonly storage: StorageSettings;
}

export interface AddedMachine {
  readonly machine: Machine;
  readonly token: string;
}

export interface MachineToAdd {
  readonly name: string;
  readonly accessClientId: string;
  readonly accessTokenId?: string;
  readonly accessExpiresAt?: number | null;
  readonly system?: MachineSystem;
  readonly hub?: string;
}

export interface MachineStore {
  add(request: MachineToAdd): AddedMachine;
  revoke(name: string): Machine | undefined;
  get(name: string): Machine | undefined;
  active(name: string): Machine | undefined;
  list(): Machine[];
  byToken(token: string): Machine | undefined;
  seen(name: string, report?: MachineReport): void;
  warned(name: string): void;
  setStorage(name: string, storage: StorageSettings): boolean;
  changed(): boolean;
}

export class MachineError extends Error {}

const MachineRow = z.object({
  name: z.string(),
  token_hash: z.string(),
  access_client_id: z.string(),
  access_token_id: z.string().nullable(),
  access_expires_at: z.number().int().nullable(),
  access_warned_at: z.number().int().nullable(),
  system: MachineSystem.nullable(),
  hub: z.string().nullable(),
  created_at: z.number().int(),
  revoked_at: z.number().int().nullable(),
  last_seen_at: z.number().int().nullable(),
  report: z.string().nullable(),
  storage: z.string().nullable(),
});

const storageDefaults = new Map<string, StorageSettings>([
  ["pc", { projectsDir: "C:\\01_Projects", artifactsDir: "M:\\Zdir\\Super-agent" }],
  ["mac-mini", { projectsDir: "/Users/novan/Novan/Code Projects", artifactsDir: "/Volumes/NAS/Zdir/Super-agent" }],
]);

const DataVersion = z.object({ data_version: z.number().int() });

function parseReport(text: string | null): MachineReport | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed = MachineReport.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toMachine(row: unknown): Machine {
  const value = MachineRow.parse(row);
  return {
    name: value.name,
    tokenHash: value.token_hash,
    accessClientId: value.access_client_id,
    accessTokenId: value.access_token_id,
    accessExpiresAt: value.access_expires_at,
    accessWarnedAt: value.access_warned_at,
    system: value.system,
    hub: value.hub,
    createdAt: value.created_at,
    revokedAt: value.revoked_at,
    lastSeenAt: value.last_seen_at,
    report: parseReport(value.report),
    storage: value.storage === null ? (storageDefaults.get(value.name) ?? {}) : StorageSettings.parse(JSON.parse(value.storage)),
  };
}

export const runnerTokenPattern = /^[A-Za-z0-9_-]{43,}$/;

export function runnerTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createMachineStore(database: HubDatabase, clock: Clock): MachineStore {
  const { connection } = database;
  const selectOne = connection.prepare("SELECT * FROM machines WHERE name = ?");
  const selectAll = connection.prepare("SELECT * FROM machines ORDER BY name");
  const selectByHash = connection.prepare("SELECT * FROM machines WHERE token_hash = ? AND revoked_at IS NULL");
  const insert = connection.prepare(
    "INSERT INTO machines (token_hash, access_client_id, access_token_id, access_expires_at, system, hub, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const replace = connection.prepare(
    "UPDATE machines SET token_hash = ?, access_client_id = ?, access_token_id = ?, access_expires_at = ?, system = ?, hub = ?, created_at = ?, access_warned_at = NULL, revoked_at = NULL, last_seen_at = NULL, report = NULL WHERE name = ?",
  );
  const markWarned = connection.prepare("UPDATE machines SET access_warned_at = ? WHERE name = ?");
  const markRevoked = connection.prepare("UPDATE machines SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL");
  const markSeen = connection.prepare("UPDATE machines SET last_seen_at = ? WHERE name = ?");
  const markReport = connection.prepare("UPDATE machines SET last_seen_at = ?, report = ? WHERE name = ?");
  const setStorage = connection.prepare("UPDATE machines SET storage = ? WHERE name = ? AND revoked_at IS NULL");
  const dataVersion = connection.prepare("PRAGMA data_version");
  const version = () => DataVersion.parse(dataVersion.get()).data_version;
  let lastVersion = version();

  const get = (name: string): Machine | undefined => {
    const row = selectOne.get(name);
    return row === undefined ? undefined : toMachine(row);
  };

  return {
    add: (request) => {
      const name = MachineName.safeParse(request.name);
      if (!name.success) {
        throw new MachineError(`${request.name} is not a machine name: use lower-case letters, digits and dashes, not hub or nas`);
      }
      if (request.accessClientId.trim() === "") {
        throw new MachineError("The Access client id is empty");
      }
      const existing = get(name.data);
      if (existing !== undefined && existing.revokedAt === null) {
        throw new MachineError(`A machine named ${name.data} already exists; revoke it first`);
      }
      const token = randomBytes(32).toString("base64url");
      const hash = runnerTokenHash(token);
      const now = clock.now();
      const values = [hash, request.accessClientId, request.accessTokenId ?? null, request.accessExpiresAt ?? null, request.system ?? null, request.hub ?? null, now, name.data];
      if (existing === undefined) {
        insert.run(...values);
      } else {
        replace.run(...values);
      }
      const machine = get(name.data);
      if (machine === undefined) {
        throw new Error(`Machine ${name.data} was not stored`);
      }
      return { machine, token };
    },
    revoke: (name) => {
      markRevoked.run(clock.now(), name);
      return get(name);
    },
    get,
    active: (name) => {
      const machine = get(name);
      return machine?.revokedAt === null ? machine : undefined;
    },
    list: () => selectAll.all().map(toMachine),
    byToken: (token) => {
      if (!runnerTokenPattern.test(token)) {
        return undefined;
      }
      const row = selectByHash.get(runnerTokenHash(token));
      return row === undefined ? undefined : toMachine(row);
    },
    seen: (name, report) => {
      if (report === undefined) {
        markSeen.run(clock.now(), name);
      } else {
        markReport.run(clock.now(), JSON.stringify(report), name);
      }
    },
    warned: (name) => {
      markWarned.run(clock.now(), name);
    },
    setStorage: (name, storage) => setStorage.run(JSON.stringify(storage), name).changes !== 0,
    changed: () => {
      const current = version();
      if (current === lastVersion) {
        return false;
      }
      lastVersion = current;
      return true;
    },
  };
}
