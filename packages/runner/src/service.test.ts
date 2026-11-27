import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { formatSettings, runnerFiles } from "./config.js";
import type { LinkSocketEvents } from "./link.js";
import { startRunnerService } from "./service.js";

let home = "";
afterEach(() => {
  vi.useRealTimers();
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

it.each(["win32", "darwin", "linux"] as const)("schedules allowance reads on %s", async (platform) => {
  home = mkdtempSync(join(tmpdir(), "runner-allowance-"));
  const files = runnerFiles(home);
  writeFileSync(files.settings, formatSettings({ SUPERAGENT2_HUB: "http://localhost:1234", MACHINE_NAME: "test", ACCESS_CLIENT_ID: "id", ACCESS_CLIENT_SECRET: "secret", RUNNER_TOKEN: "a".repeat(43) }));
  const calls: string[][] = [];
  const sent: unknown[] = [];
  let events: LinkSocketEvents | undefined;
  vi.useFakeTimers();
  const service = await startRunnerService({
    files, platform, environment: { SUPERAGENT2_PROGRAM_AUTO_UPDATE: "0" }, log: () => undefined,
    sampleLoad: async () => ({ sampledAt: Date.now(), cpuPercent: 25, ownCpuPercent: 8, gpuPercent: platform === "linux" ? null : 10 }),
    prober: { find: (name) => name === "codex" ? "/codex" : undefined, capture: async (_path, args) => { calls.push([...args]); return args[0] === "--version" ? "codex-cli 1.0.0" : ""; } },
    connect: (_url, _headers, handlers) => { events = handlers; return { send: (message) => sent.push(JSON.parse(message)), close: () => handlers.close(1000, ""), terminate: () => handlers.close(1000, "") }; },
  });
  if (service === undefined || events === undefined) throw new Error("Runner did not start");
  events.open();
  await service.allowanceRead;
  const allowanceCalls = () => calls.filter((args) => args[0] === "app-server").length;
  expect(allowanceCalls()).toBe(platform === "win32" ? 0 : 1);
  events.message(JSON.stringify({ type: "allowance.refresh" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(allowanceCalls()).toBe(platform === "win32" ? 0 : 2);
  events.message(JSON.stringify({ type: "programs.refresh", id: "00000000-0000-4000-8000-000000000000" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(allowanceCalls()).toBe(platform === "win32" ? 0 : 3);
  expect(sent).toContainEqual(expect.objectContaining({
    type: "report", refreshId: "00000000-0000-4000-8000-000000000000",
    machine: expect.objectContaining({ load: expect.objectContaining({ cpuPercent: 25, ownCpuPercent: 8, gpuPercent: platform === "linux" ? null : 10 }) }),
  }));
  await vi.advanceTimersByTimeAsync(600_000);
  expect(allowanceCalls()).toBe(platform === "win32" ? 0 : 4);
  const reports = sent.filter((message): message is { machine: { allowances: unknown[] } } => typeof message === "object" && message !== null && "machine" in message);
  if (platform === "win32") expect(reports.every((message) => message.machine.allowances.length === 0)).toBe(true);
  expect(calls.some((args) => args[0] === "--version")).toBe(true);
  await service.close();
});

async function startOn(platform: NodeJS.Platform) {
  home = mkdtempSync(join(tmpdir(), "runner-allowance-"));
  const files = runnerFiles(home);
  writeFileSync(files.settings, formatSettings({ SUPERAGENT2_HUB: "http://localhost:1234", MACHINE_NAME: "test", ACCESS_CLIENT_ID: "id", ACCESS_CLIENT_SECRET: "secret", RUNNER_TOKEN: "a".repeat(43) }));
  const calls: string[][] = [];
  const lines: string[] = [];
  let events: LinkSocketEvents | undefined;
  vi.useFakeTimers();
  const service = await startRunnerService({
    files, platform, environment: { SUPERAGENT2_PROGRAM_AUTO_UPDATE: "0" }, log: (line) => lines.push(line),
    sampleLoad: async () => ({ sampledAt: Date.now(), cpuPercent: null, ownCpuPercent: null, gpuPercent: null }),
    prober: { find: (name) => name === "codex" ? "/codex" : undefined, capture: async (_path, args) => { calls.push([...args]); return args[0] === "--version" ? "codex-cli 1.0.0" : ""; } },
    connect: (_url, _headers, handlers) => { events = handlers; return { send: () => undefined, close: () => handlers.close(1000, ""), terminate: () => handlers.close(1000, "") }; },
  });
  if (service === undefined) throw new Error("Runner did not start");
  let welcomed: LinkSocketEvents | undefined;
  const hub = () => {
    if (events === undefined) throw new Error("Runner did not connect");
    if (welcomed !== events) {
      welcomed = events;
      events.open();
      events.message(JSON.stringify({ type: "welcome", protocol: 1, name: "test" }));
    }
    return events;
  };
  hub();
  await service.allowanceRead;
  const tell = async (message: unknown) => { hub().message(JSON.stringify(message)); await vi.advanceTimersByTimeAsync(0); };
  return { service, lines, tell, reads: () => calls.filter((args) => args[0] === "app-server").length };
}

it("reads allowances on Windows only while the hub says no macOS or Linux runner is online", async () => {
  const { service, lines, tell, reads } = await startOn("win32");
  expect(reads()).toBe(0);
  await tell({ type: "allowance.mode", read: true });
  expect(reads()).toBe(1);
  expect(lines).toContain("No macOS or Linux runner is online, so this Windows runner reads the allowance");
  await tell({ type: "allowance.refresh" });
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(reads()).toBe(3);
  await tell({ type: "allowance.mode", read: true });
  expect(reads()).toBe(3);
  await tell({ type: "allowance.mode", read: false });
  expect(lines).toContain("A macOS or Linux runner is online, so this Windows runner stops reading the allowance");
  await tell({ type: "allowance.refresh" });
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(reads()).toBe(3);
  await tell({ type: "allowance.mode", read: true });
  expect(reads()).toBe(4);
  await vi.advanceTimersByTimeAsync(60_000);
  await tell({ type: "allowance.mode", read: false });
  await tell({ type: "allowance.mode", read: true });
  expect(reads()).toBe(4);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(reads()).toBe(5);
  await service.close();
});

it("keeps reading allowances on macOS whatever allowance mode the hub sends", async () => {
  const { service, tell, reads } = await startOn("darwin");
  expect(reads()).toBe(1);
  await tell({ type: "allowance.mode", read: false });
  await tell({ type: "allowance.refresh" });
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(reads()).toBe(3);
  await service.close();
});
