import { defaultMachineLoadSettings, type MachineLoad } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { monitorMachineLoad } from "./machine-load.js";

describe("machine load hysteresis", () => {
  const high = { cpuPercent: 85, ownCpuPercent: 3, gpuPercent: null };
  const low = { cpuPercent: 25, ownCpuPercent: 3, gpuPercent: 5 };

  function monitor() {
    let now = 0;
    const state = monitorMachineLoad(() => now);
    const sample = (seconds: number, load: Omit<MachineLoad, "sampledAt">) => {
      now = seconds * 1_000;
      return state.read({ ...load, sampledAt: now }, defaultMachineLoadSettings);
    };
    return { sample, state };
  }

  it("requires consecutive fresh high and low readings and ignores duplicate reports", () => {
    const { sample } = monitor();
    expect(sample(0, high)?.high).toBe(false);
    expect(sample(15, low)?.high).toBe(false);
    for (let second = 30; second < 150; second += 15) expect(sample(second, high)?.high).toBe(false);
    expect(sample(150, high)).toMatchObject({ high: true, since: 150_000 });
    expect(sample(150, low)).toMatchObject({ high: true, cpuPercent: 85 });
    expect(sample(165, low)?.high).toBe(true);
    expect(sample(180, { ...low, gpuPercent: 35 })?.high).toBe(true);
    for (let second = 195; second < 495; second += 15) expect(sample(second, low)?.high).toBe(true);
    expect(sample(495, low)).toMatchObject({ high: false, since: null });
  });

  it("discounts worker CPU, treats a missing GPU independently, and restarts after a sampling gap", () => {
    const { sample } = monitor();
    for (let second = 0; second <= 120; second += 15) {
      expect(sample(second, { ...high, cpuPercent: 95, ownCpuPercent: 65 })?.high).toBe(false);
    }
    expect(sample(135, { ...high, gpuPercent: 80 })?.high).toBe(false);
    expect(sample(300, { ...low, gpuPercent: 80 })?.high).toBe(false);
    for (let second = 330; second < 420; second += 30) {
      expect(sample(second, { ...low, gpuPercent: 80 })?.high).toBe(false);
    }
    expect(sample(420, { ...low, gpuPercent: 80 })?.high).toBe(true);
  });
});
