import { describe, expect, it, vi } from "vitest";
import { createLoadSampler, hardwareLoad, loadChanged, type LoadCommand } from "./machine-load.js";

describe("runner load sampling", () => {
  it("separates CPU attributed to the runner and its descendants from the system total", async () => {
    let at = 0;
    const cpu = vi.fn()
      .mockReturnValueOnce({ total: 100_000, idle: 20_000 })
      .mockReturnValueOnce({ total: 160_000, idle: 26_000 })
      .mockReturnValueOnce({ total: 220_000, idle: 32_000 });
    const hardware = vi.fn()
      .mockResolvedValueOnce({ gpuPercent: null, processes: [
        { pid: 1, parent: 0, milliseconds: 1_000 },
        { pid: 2, parent: 1, milliseconds: 5_000 },
        { pid: 3, parent: 2, milliseconds: 10_000 },
      ] })
      .mockResolvedValueOnce({ gpuPercent: 12, processes: [
        { pid: 1, parent: 0, milliseconds: 1_000 },
        { pid: 2, parent: 1, milliseconds: 15_000 },
        { pid: 3, parent: 2, milliseconds: 46_000 },
        { pid: 4, parent: 0, milliseconds: 100_000 },
      ] })
      .mockResolvedValueOnce({ gpuPercent: 12, processes: [
        { pid: 1, parent: 0, milliseconds: 1_000 },
        { pid: 2, parent: 1, milliseconds: 75_000 },
        { pid: 4, parent: 0, milliseconds: 100_000 },
      ] });
    const sample = createLoadSampler({ platform: "darwin", now: () => at, pid: 1, cpu, hardware });
    expect(await sample()).toEqual({ cpuPercent: null, ownCpuPercent: null, gpuPercent: null, sampledAt: 0 });
    at += 15_000;
    expect(await sample()).toEqual({ cpuPercent: 90, ownCpuPercent: 76.7, gpuPercent: 12, sampledAt: at });
    at += 15_000;
    expect(await sample()).toEqual({ cpuPercent: 90, ownCpuPercent: 23.3, gpuPercent: 12, sampledAt: at });
  });

  it("runs Windows helpers hidden and aggregates process counters by adapter and engine", async () => {
    const command = vi.fn<LoadCommand>().mockResolvedValue(JSON.stringify({
      processes: [{ pid: 12, parent: 9, bornAt: 42, milliseconds: 345 }],
      gpu: [
        { name: "pid_12_luid_0x0_0x123_phys_0_eng_3_engtype_3D", utilization: 61 },
        { name: "pid_13_luid_0x0_0x123_phys_0_eng_3_engtype_3D", utilization: 18 },
        { name: "pid_13_luid_0x0_0x123_phys_0_eng_4_engtype_Copy", utilization: 35 },
        { name: "pid_14_luid_0x0_0x555_phys_0_eng_3_engtype_3D", utilization: 40 },
      ],
    }));
    expect(await hardwareLoad("win32", command)()).toEqual({ gpuPercent: 79, processes: [{ pid: 12, parent: 9, bornAt: 42, milliseconds: 345 }] });
    expect(command).toHaveBeenCalledExactlyOnceWith("powershell.exe", expect.arrayContaining(["-NonInteractive"]), expect.objectContaining({ windowsHide: true }));
    command.mockRejectedValue(new Error("Counters are unavailable"));
    expect(await hardwareLoad("win32", command)()).toEqual({ processes: null, gpuPercent: null });
  });

  it.runIf(process.platform === "win32")("reads the live Windows runner process", async () => {
    const { processes } = await hardwareLoad("win32")();
    expect(processes).toContainEqual(expect.objectContaining({ pid: process.pid, parent: process.ppid }));
  });

  it("reads macOS accelerator utilization and process times without privileged commands", async () => {
    const command = vi.fn<LoadCommand>()
      .mockResolvedValueOnce("  123  45  1:02:03.45\n   45   1  0:01.23\n")
      .mockResolvedValueOnce(' "PerformanceStatistics" = {"Device Utilization %"=10}\n "PerformanceStatistics" = {"Device Utilization %"=78}');
    expect(await hardwareLoad("darwin", command)()).toEqual({ gpuPercent: 78, processes: [
      { pid: 123, parent: 45, milliseconds: 3_723_450 },
      { pid: 45, parent: 1, milliseconds: 1_230 },
    ] });
  });

  it("suppresses stationary readings and reports a change or a periodic refresh", () => {
    const before = { cpuPercent: 36, ownCpuPercent: 2, gpuPercent: null, sampledAt: 0 };
    expect(loadChanged(before, { ...before, cpuPercent: 36.3, sampledAt: 15_000 })).toBe(false);
    expect(loadChanged(before, { ...before, gpuPercent: 0, sampledAt: 15_000 })).toBe(true);
    expect(loadChanged(before, { ...before, sampledAt: 30_000 })).toBe(true);
  });
});
