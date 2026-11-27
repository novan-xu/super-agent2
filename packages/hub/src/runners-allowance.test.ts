import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HubToRunner, type MachineReport, protocolVersion } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HubDatabase, openDatabase } from "./database.js";
import { createMachineStore, type MachineStore } from "./machines.js";
import { allowanceFallbackDelay, createRunners, type RunnerLink, type Runners } from "./runners.js";
import { TestClock } from "./testing/access.js";

const clientId = "0123456789abcdef.access";
const windows: MachineReport = { hostname: "pc", platform: "win32", release: "10.0", arch: "x64", user: "owner", slots: { total: 2, free: 2 }, programs: [], allowances: [] };
const mac: MachineReport = { ...windows, hostname: "mini", platform: "darwin", release: "25.0", arch: "arm64" };

let dataDir: string;
let clock: TestClock;
let database: HubDatabase;
let machines: MachineStore;
let runners: Runners | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-allowance-"));
  clock = new TestClock();
  database = openDatabase({ dataDir, clock });
  machines = createMachineStore(database, clock);
  for (const name of ["pc", "laptop", "mini"]) machines.add({ name, accessClientId: clientId });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  runners?.close();
  runners = undefined;
  database.connection.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function startRunners(): Runners {
  runners = createRunners({ machines, now: () => clock.now() });
  return runners;
}

function connect(name: string, report: MachineReport): { sent: HubToRunner[]; link: RunnerLink; modes: () => boolean[] } {
  const machine = machines.active(name);
  if (machine === undefined || runners === undefined) throw new Error(`no machine ${name}`);
  const sent: HubToRunner[] = [];
  const link = runners.attach(machine, { send: (message) => sent.push(message), close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, machine: report, works: [] });
  return { sent, link, modes: () => sent.flatMap((message) => message.type === "allowance.mode" ? [message.read] : []) };
}

function advance(milliseconds: number): void {
  clock.advance(milliseconds);
  vi.advanceTimersByTime(milliseconds);
}

const refreshed = (sent: readonly HubToRunner[]) => sent.filter((message) => message.type === "allowance.refresh").length;

describe("allowance readings on Windows runners", () => {
  it("lets Windows runners read when they are the only runners online", () => {
    const hub = startRunners();
    const pc = connect("pc", windows);
    const laptop = connect("laptop", windows);
    expect(pc.sent.slice(0, 2)).toEqual([expect.objectContaining({ type: "welcome" }), { type: "allowance.mode", read: true }]);
    expect(laptop.modes()).toEqual([true]);
    expect(hub.refreshAllowance()).toBe(2);
    expect(refreshed(pc.sent)).toBe(1);
    expect(refreshed(laptop.sent)).toBe(1);
  });

  it("stops Windows reads while a macOS runner is online and resumes them after it has been gone for a while", () => {
    const hub = startRunners();
    const pc = connect("pc", windows);
    const mini = connect("mini", mac);
    expect(pc.modes()).toEqual([true, false]);
    expect(mini.modes()).toEqual([]);
    expect(hub.refreshAllowance()).toBe(1);
    expect(refreshed(pc.sent)).toBe(0);
    expect(refreshed(mini.sent)).toBe(1);
    mini.link.closed();
    expect(pc.modes()).toEqual([true, false]);
    expect(hub.refreshAllowance()).toBe(0);
    advance(allowanceFallbackDelay - 1);
    expect(pc.modes()).toEqual([true, false]);
    advance(1);
    expect(pc.modes()).toEqual([true, false, true]);
    expect(hub.refreshAllowance()).toBe(1);
    expect(refreshed(pc.sent)).toBe(1);
  });

  it("keeps Windows runners quiet when a macOS runner reconnects briefly", () => {
    startRunners();
    const pc = connect("pc", windows);
    connect("mini", mac).link.closed();
    advance(30_000);
    connect("mini", mac);
    advance(allowanceFallbackDelay * 2);
    expect(pc.modes()).toEqual([true, false]);
  });

  it("waits after a hub restart for a macOS runner that was online before", () => {
    machines.seen("mini", mac);
    advance(10_000);
    startRunners();
    const pc = connect("pc", windows);
    expect(pc.modes()).toEqual([false]);
    advance(allowanceFallbackDelay - 10_000);
    expect(pc.modes()).toEqual([false, true]);
  });

  it("does not wait after a hub restart once the macOS runner is long gone or revoked", () => {
    machines.seen("mini", mac);
    advance(allowanceFallbackDelay);
    startRunners();
    expect(connect("pc", windows).modes()).toEqual([true]);
    runners?.close();
    machines.seen("mini", mac);
    machines.revoke("mini");
    startRunners();
    expect(connect("laptop", windows).modes()).toEqual([true]);
  });

  it("tells a Windows runner the current mode again when it reconnects", () => {
    startRunners();
    connect("mini", mac);
    const first = connect("pc", windows);
    expect(first.modes()).toEqual([false]);
    first.link.closed();
    expect(connect("pc", windows).modes()).toEqual([false]);
  });
});
