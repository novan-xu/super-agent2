import { randomUUID } from "node:crypto";
import { text } from "@super-agent2/catalog";
import {
  type HubToRunner,
  type Identity,
  type MachineReport,
  type MachineStatus,
  protocolVersion,
  runnerCloseCodes,
  type RunnerToHub,
} from "@super-agent2/protocol";
import { interruptedReason } from "./commands.js";
import type { Machine, MachineStore } from "./machines.js";
import type { ExecutionEnd, OutputSink, Target, TargetDirectory } from "./targets.js";

export interface RunnerConnection {
  send(message: HubToRunner): void;
  close(code: number, reason: string): void;
}

export interface RunnerLink {
  receive(message: RunnerToHub): void;
  closed(): void;
}

export interface Runners extends TargetDirectory {
  admit(identity: Identity, token: string | undefined): Machine | undefined;
  attach(machine: Machine, connection: RunnerConnection): RunnerLink;
  revoke(name: string): Machine | undefined;
  statuses(): MachineStatus[];
  describe(): string;
  sweep(): void;
  close(): void;
}

export interface RunnersOptions {
  readonly machines: MachineStore;
  readonly pollMilliseconds?: number;
}

interface Pending {
  readonly sink: OutputSink;
  readonly resolve: (end: ExecutionEnd) => void;
  readonly reject: (error: Error) => void;
}

interface Link {
  readonly machine: Machine;
  readonly connection: RunnerConnection;
  readonly pending: Map<string, Pending>;
  report: MachineReport | undefined;
}

const systemNames: Readonly<Record<string, string>> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function createRunners(options: RunnersOptions): Runners {
  const { machines } = options;
  const links = new Map<string, Link>();

  const end = (link: Link, reason: string) => {
    const pending = [...link.pending.values()];
    link.pending.clear();
    for (const entry of pending) {
      entry.resolve({ exitCode: null, signal: null, lost: reason });
    }
  };

  const drop = (link: Link, code: number, reason: string, lost: string) => {
    if (links.get(link.machine.name) === link) {
      links.delete(link.machine.name);
    }
    end(link, lost);
    link.connection.close(code, reason);
  };

  const sweep = () => {
    for (const link of [...links.values()]) {
      const current = machines.active(link.machine.name);
      if (current === undefined || current.tokenHash !== link.machine.tokenHash) {
        drop(link, runnerCloseCodes.revoked, "revoked", text("command.reason.machineLost", { target: link.machine.name }));
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

  const target = (name: string): Target => ({
    name,
    run: (job, sink) => {
      const link = links.get(name);
      if (link?.report === undefined) {
        throw new Error(text("command.reason.offline", { target: name }));
      }
      const id = randomUUID();
      const ended = new Promise<ExecutionEnd>((resolve, reject) => {
        link.pending.set(id, { sink, resolve, reject });
      });
      link.connection.send({ type: "run", id, command: job.command, cwd: job.cwd ?? null, environment: { ...job.credentials } });
      return {
        ended,
        stop: async () => {
          if (links.get(name) === link && link.pending.has(id)) {
            link.connection.send({ type: "stop", id });
          }
        },
      };
    },
  });

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
        };
      });

  return {
    find: (name) => (machines.active(name) === undefined ? undefined : target(name)),
    names: () => statuses().map((status) => status.name),
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
        drop(previous, runnerCloseCodes.replaced, "replaced", text("command.reason.machineLost", { target: machine.name }));
      }
      const link: Link = { machine, connection, pending: new Map(), report: undefined };
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
              connection.send({ type: "welcome", protocol: protocolVersion, name: machine.name });
            }
            return;
          }
          const pending = link.pending.get(message.id);
          if (pending === undefined) {
            return;
          }
          if (message.type === "output") {
            pending.sink(message.stream, Buffer.from(message.data, "base64"));
            return;
          }
          link.pending.delete(message.id);
          if (message.type === "ended") {
            pending.resolve({ exitCode: message.exitCode, signal: message.signal });
          } else {
            pending.reject(new Error(message.reason));
          }
        },
        closed: () => {
          if (links.get(machine.name) === link) {
            links.delete(machine.name);
            machines.seen(machine.name);
          }
          end(link, text("command.reason.machineLost", { target: machine.name }));
        },
      };
    },
    revoke: (name) => {
      const machine = machines.revoke(name);
      sweep();
      return machine;
    },
    statuses,
    describe: () =>
      statuses()
        .map((status) => {
          const system = status.report === null ? "" : `${systemNames[status.report.platform] ?? status.report.platform}, `;
          return `"${status.name}" is a work machine (${system}${status.online ? "online" : "offline"})`;
        })
        .join("; "),
    sweep,
    close: () => {
      clearInterval(timer);
      for (const link of [...links.values()]) {
        drop(link, runnerCloseCodes.closing, "hub closing", interruptedReason);
      }
    },
  };
}
