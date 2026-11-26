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
