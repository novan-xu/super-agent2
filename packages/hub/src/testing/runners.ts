import type { MachineReport, WorkHeld } from "@super-agent2/protocol";
import type { WorkLink, WorkMessageToRunner } from "../runners.js";
import type { WorkRunners } from "../work.js";

export class FakeRunners implements WorkRunners {
  link: WorkLink | undefined;
  readonly sent: { readonly machine: string; readonly message: WorkMessageToRunner }[] = [];
  readonly online = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  bindWork(link: WorkLink): void {
    this.link = link;
  }

  sendWork(machine: string, message: WorkMessageToRunner): boolean {
    if (!this.online.has(machine)) {
      return false;
    }
    this.sent.push({ machine, message });
    return true;
  }

  report(machine: string): MachineReport | undefined {
    const total = this.online.get(machine);
    if (total === undefined) {
      return undefined;
    }
    return { hostname: machine, platform: "win32", release: "1", arch: "x64", user: "owner", slots: { total, free: total }, programs: [], allowances: [] };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(machine: string, slots: number, held: readonly WorkHeld[] = []): void {
    this.online.set(machine, slots);
    this.link?.hello(machine, held);
    for (const listener of this.listeners) {
      listener();
    }
  }

  drop(machine: string): void {
    this.online.delete(machine);
    this.link?.closed(machine);
  }

  of<T extends WorkMessageToRunner["type"]>(type: T, machine?: string): Extract<WorkMessageToRunner, { readonly type: T }>[] {
    return this.sent
      .filter((entry) => entry.message.type === type && (machine === undefined || entry.machine === machine))
      .map((entry) => entry.message as Extract<WorkMessageToRunner, { readonly type: T }>);
  }
}
