import {
  type HubToRunner,
  type Identity,
  type MachineReport,
  type MachineStatus,
  protocolVersion,
  runnerCloseCodes,
  type RunnerToHub,
  type FetchAttachment,
  type FilePart,
  type RunnerWorkEvent,
  type WorkHeld,
} from "@super-agent2/protocol";
import type { Machine, MachineStore } from "./machines.js";

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
  bindWork(link: WorkLink): void;
  sendWork(machine: string, message: WorkMessageToRunner): boolean;
  report(machine: string): MachineReport | undefined;
  admit(identity: Identity, token: string | undefined): Machine | undefined;
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
}

interface Link {
  readonly machine: Machine;
  readonly connection: RunnerConnection;
  report: MachineReport | undefined;
}

export function createRunners(options: RunnersOptions): Runners {
  const { machines } = options;
  const links = new Map<string, Link>();
  let work: WorkLink | undefined;
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
          ...(machine.system === null ? {} : { system: machine.system }),
          ...(machine.accessExpiresAt === null ? {} : { accessExpiresAt: machine.accessExpiresAt }),
        };
      });

  return {
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
    report: (name) => links.get(name)?.report,
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
    attach: (machine, connection) => {
      const previous = links.get(machine.name);
      if (previous !== undefined) {
        drop(previous, runnerCloseCodes.replaced, "replaced");
      }
      const link: Link = { machine, connection, report: undefined };
      links.set(machine.name, link);
      return {
        receive: (message) => {
          if (links.get(machine.name) !== link) {
            return;
          }
          if (message.type === "hello" || message.type === "report") {
            const first = link.report === undefined;
            link.report = message.machine;
            machines.seen(machine.name, message.machine);
            if (first) {
              connection.send({ type: "welcome", protocol: protocolVersion, name: machine.name, ...(options.version === undefined ? {} : { version: options.version }) });
            }
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
          tellWork((bound) => bound.attachment?.(machine.name, message));
        },
        closed: () => {
          if (links.get(machine.name) === link) {
            links.delete(machine.name);
            machines.seen(machine.name);
            tellWork((bound) => bound.closed(machine.name));
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
      clearInterval(timer);
      listeners.clear();
      for (const link of [...links.values()]) {
        drop(link, runnerCloseCodes.closing, "hub closing");
      }
    },
  };
}
