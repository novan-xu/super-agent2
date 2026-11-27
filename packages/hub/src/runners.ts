import { randomUUID } from "node:crypto";
import {
  defaultMachineLoadSettings,
  type CancelCheck,
  type CheckReply,
  type HubToRunner,
  type Identity,
  type MachineReport,
  type MachineLoadSettings,
  type MachineStatus,
  protocolVersion,
  runnerCloseCodes,
  type RunnerToHub,
  type RunCheck,
  type FetchAttachment,
  type FilePart,
  type RunnerWorkEvent,
  type WorkHeld,
} from "@super-agent2/protocol";
import type { Machine, MachineStore } from "./machines.js";
import { monitorMachineLoad } from "./machine-load.js";
import type { StorageSettings } from "@super-agent2/protocol";

export interface RunnerConnection {
  send(message: HubToRunner): void;
  close(code: number, reason: string): void;
}

export interface RunnerLink {
  receive(message: RunnerToHub): void;
  closed(): void;
}

export type WorkMessageToRunner = Extract<HubToRunner, { readonly type: "work.start" | "work.task" | "work.sync" | "work.message" | "work.stop" | "work.file" | "work.attachment.part" }>;

export interface WorkLink {
  hello(machine: string, works: readonly WorkHeld[]): void;
  event(machine: string, message: RunnerWorkEvent): void;
  part(machine: string, message: FilePart): void;
  attachment?(machine: string, message: FetchAttachment): void;
  closed(machine: string): void;
}

export interface Runners {
  bindChecks(receive: (machine: string, message: CheckReply) => void): () => void;
  sendCheck(machine: string, message: RunCheck | CancelCheck): boolean;
  bindWork(link: WorkLink): void;
  sendWork(machine: string, message: WorkMessageToRunner): boolean;
  refreshAllowance(): number;
  refreshPrograms(machine?: string): Promise<{ name: string; report?: MachineReport; status: "refreshed" | "not reached" | "timed out" }[]>;
  report(machine: string): MachineReport | undefined;
  setStorage(machine: string, storage: StorageSettings): boolean;
  setLoadSettings(settings: MachineLoadSettings): void;
  admit(identity: Identity, token: string | undefined): Machine | undefined;
  admitLocal(token: string | undefined): Machine | undefined;
  attach(machine: Machine, connection: RunnerConnection): RunnerLink;
  revoke(name: string): Machine | undefined;
  statuses(): MachineStatus[];
  sweep(): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export interface RunnersOptions {
  readonly machines: MachineStore;
  readonly pollMilliseconds?: number;
  readonly version?: string;
  readonly now?: () => number;
  readonly allowanceFallbackMilliseconds?: number;
}

/** How long the hub waits after the last macOS or Linux runner went away before Windows runners read allowances instead. */
export const allowanceFallbackDelay = 2 * 60 * 1000;

interface Link {
  readonly machine: Machine;
  readonly connection: RunnerConnection;
  report: MachineReport | undefined;
  readonly load: ReturnType<typeof monitorMachineLoad>;
  allowanceMode: boolean | undefined;
}

const readsAllowance = (report: MachineReport | null | undefined): boolean => report !== undefined && report !== null && report.platform !== "win32";

export function createRunners(options: RunnersOptions): Runners {
  const { machines } = options;
  const links = new Map<string, Link>();
  let loadSettings = defaultMachineLoadSettings;
  const refreshes = new Map<string, { name: string; finish: (report?: MachineReport) => void }>();
  let work: WorkLink | undefined;
  let checks: ((machine: string, message: CheckReply) => void) | undefined;
  const tellWork = (body: (link: WorkLink) => void) => {
    if (work === undefined) {
      return;
    }
    try {
      body(work);
    } catch {
      return;
    }
  };
  const now = options.now ?? Date.now;
  const fallbackDelay = options.allowanceFallbackMilliseconds ?? allowanceFallbackDelay;
  // When a macOS or Linux runner was last online, so that a brief reconnect or a hub restart does not
  // start allowance programs on Windows runners right away.
  let readerSeenAt = machines.list()
    .filter((machine) => machine.revokedAt === null && readsAllowance(machine.report))
    .reduce<number | undefined>((latest, machine) => Math.max(latest ?? 0, machine.lastSeenAt ?? 0), undefined);
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const readerOnline = () => [...links.values()].some((link) => readsAllowance(link.report));
  const windowsReads = () => !readerOnline() && (readerSeenAt === undefined || now() - readerSeenAt >= fallbackDelay);
  const updateAllowanceMode = () => {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
    if (closing) return;
    const read = windowsReads();
    for (const link of links.values()) {
      if (link.report?.platform !== "win32" || link.allowanceMode === read) continue;
      link.allowanceMode = read;
      link.connection.send({ type: "allowance.mode", read });
    }
    if (!read && !readerOnline() && readerSeenAt !== undefined) {
      fallbackTimer = setTimeout(updateAllowanceMode, Math.max(1000, readerSeenAt + fallbackDelay - now()));
      fallbackTimer.unref();
    }
  };
  const left = (link: Link) => {
    if (readsAllowance(link.report)) readerSeenAt = now();
    updateAllowanceMode();
  };
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  };

  const drop = (link: Link, code: number, reason: string) => {
    if (links.get(link.machine.name) === link) {
      links.delete(link.machine.name);
      tellWork((bound) => bound.closed(link.machine.name));
      left(link);
    }
    link.connection.close(code, reason);
    announce();
  };

  const sweep = () => {
    for (const link of [...links.values()]) {
      const current = machines.active(link.machine.name);
      if (current === undefined || current.tokenHash !== link.machine.tokenHash) {
        drop(link, runnerCloseCodes.revoked, "revoked");
      }
    }
  };

  const timer = setInterval(() => {
    try {
      if (machines.changed()) {
        sweep();
      }
    } catch {
      return;
    }
  }, options.pollMilliseconds ?? 1000);
  timer.unref();

  const statuses = (): MachineStatus[] =>
    machines
      .list()
      .filter((machine) => machine.revokedAt === null)
      .map((machine) => {
        const link = links.get(machine.name);
        const online = link?.report !== undefined;
        return {
          name: machine.name,
          online,
          createdAt: machine.createdAt,
          lastSeenAt: machine.lastSeenAt,
          report: link?.report ?? machine.report,
          ...(Object.keys(machine.storage).length === 0 ? {} : { storage: machine.storage }),
          ...(machine.system === null ? {} : { system: machine.system }),
          ...(machine.accessExpiresAt === null ? {} : { accessExpiresAt: machine.accessExpiresAt }),
        };
      });

  return {
    bindChecks: (receive) => {
      checks = receive;
      return () => { if (checks === receive) checks = undefined; };
    },
    sendCheck: (name, message) => {
      const link = links.get(name);
      if (link?.report?.repositoryChecks !== true) return false;
      link.connection.send(message);
      return true;
    },
    bindWork: (link) => {
      work = link;
    },
    sendWork: (name, message) => {
      const link = links.get(name);
      if (link?.report === undefined) {
        return false;
      }
      link.connection.send(message);
      return true;
    },
    refreshAllowance: () => {
      let count = 0;
      for (const link of links.values()) {
        if (link.report !== undefined && (readsAllowance(link.report) || link.allowanceMode === true)) { link.connection.send({ type: "allowance.refresh" }); count++; }
      }
      return count;
    },
    refreshPrograms: async (name) => {
      const names = name === undefined ? statuses().map((status) => status.name) : [name];
      return Promise.all(names.map(async (machine) => {
        const link = links.get(machine);
        if (link?.report === undefined) return { name: machine, status: "not reached" as const };
        const id = randomUUID();
        return new Promise<{ name: string; report?: MachineReport; status: "refreshed" | "timed out" }>((resolve) => {
          const finish = (report?: MachineReport) => {
            clearTimeout(timer);
            refreshes.delete(id);
            resolve(report === undefined ? { name: machine, status: "timed out" } : { name: machine, status: "refreshed", report });
          };
          const timer = setTimeout(() => finish(), 30000);
          refreshes.set(id, { name: machine, finish });
          link.connection.send({ type: "programs.refresh", id });
        });
      }));
    },
    report: (name) => links.get(name)?.report,
    setLoadSettings: (settings) => {
      if (JSON.stringify(settings) === JSON.stringify(loadSettings)) return;
      loadSettings = settings;
      for (const link of links.values()) link.load.reset();
      announce();
    },
    setStorage: (name, storage) => {
      if (!machines.setStorage(name, storage)) {
        return false;
      }
      const link = links.get(name);
      if (link?.report?.storage !== undefined) {
        link.connection.send({ type: "storage.set", settings: storage });
      }
      announce();
      return true;
    },
    admit: (identity, token) => {
      if (identity.kind !== "service" || token === undefined) {
        return undefined;
      }
      const machine = machines.byToken(token);
      if (machine === undefined || machine.accessClientId !== identity.clientId) {
        return undefined;
      }
      return machine;
    },
    admitLocal: (token) => token === undefined ? undefined : machines.byToken(token),
    attach: (machine, connection) => {
      const previous = links.get(machine.name);
      if (previous !== undefined) {
        drop(previous, runnerCloseCodes.replaced, "replaced");
      }
      const priorLoad = machines.active(machine.name)?.report?.load;
      const link: Link = { machine, connection, report: undefined, load: monitorMachineLoad(now, priorLoad), allowanceMode: undefined };
      links.set(machine.name, link);
      return {
        receive: (message) => {
          if (links.get(machine.name) !== link) {
            return;
          }
          if (message.type === "hello" || message.type === "report") {
            const first = link.report === undefined;
            const load = link.load.read(message.machine.load, loadSettings);
            const report = load === undefined ? message.machine : { ...message.machine, load };
            link.report = report;
            machines.seen(machine.name, report);
            if (message.type === "report" && message.refreshId !== undefined) {
              const refresh = refreshes.get(message.refreshId);
              if (refresh?.name === machine.name) refresh.finish(report);
            }
            if (first) {
              connection.send({ type: "welcome", protocol: protocolVersion, name: machine.name, ...(options.version === undefined ? {} : { version: options.version }) });
              if (message.machine.storage !== undefined) {
                connection.send({ type: "storage.set", settings: machines.active(machine.name)?.storage ?? {} });
              }
            }
            updateAllowanceMode();
            announce();
            if (message.type === "hello") {
              tellWork((bound) => bound.hello(machine.name, message.works));
            }
            return;
          }
          if (message.type === "work.event") {
            tellWork((bound) => bound.event(machine.name, message));
            return;
          }
          if (message.type === "work.file.part") {
            tellWork((bound) => bound.part(machine.name, message));
            return;
          }
          if (message.type === "check.reply") {
            checks?.(machine.name, message);
            return;
          }
          tellWork((bound) => bound.attachment?.(machine.name, message));
        },
        closed: () => {
          if (links.get(machine.name) === link) {
            links.delete(machine.name);
            machines.seen(machine.name);
            tellWork((bound) => bound.closed(machine.name));
            left(link);
          }
          announce();
        },
      };
    },
    revoke: (name) => {
      const machine = machines.revoke(name);
      sweep();
      return machine;
    },
    statuses,
    sweep,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closing = true;
      clearInterval(timer);
      clearTimeout(fallbackTimer);
      for (const refresh of refreshes.values()) refresh.finish();
      listeners.clear();
      for (const link of [...links.values()]) {
        drop(link, runnerCloseCodes.closing, "hub closing");
      }
    },
  };
}
