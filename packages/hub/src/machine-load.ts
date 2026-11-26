import type { MachineLoad, MachineLoadSettings } from "@super-agent2/protocol";

const sampleGap = 45_000;
const minute = 60_000;

export function monitorMachineLoad(now: () => number, previous?: MachineLoad) {
  let high = previous?.high === true;
  let since = high ? previous?.since ?? null : null;
  let last: MachineLoad | undefined;
  let candidate: number | undefined;

  return {
    reset: () => { candidate = undefined; },
    read: (sample: MachineLoad | undefined, limits: MachineLoadSettings): MachineLoad | undefined => {
      if (sample === undefined) {
        high = false;
        since = null;
        last = undefined;
        candidate = undefined;
        return undefined;
      }
      if (last !== undefined) {
        if (sample.sampledAt === last.sampledAt) return last;
        if (sample.sampledAt < last.sampledAt || sample.sampledAt - last.sampledAt > sampleGap) candidate = undefined;
      }
      const cpu = sample.cpuPercent === null || sample.ownCpuPercent === null ? null : Math.max(0, sample.cpuPercent - sample.ownCpuPercent);
      const gpu = sample.gpuPercent;
      const shouldChange = high
        ? (cpu !== null || gpu !== null) && (cpu === null || cpu <= limits.cpuLow) && (gpu === null || gpu <= limits.gpuLow)
        : (cpu !== null && cpu > limits.cpuHigh) || (gpu !== null && gpu > limits.gpuHigh);
      if (shouldChange) {
        candidate ??= sample.sampledAt;
        if (sample.sampledAt - candidate >= minute * (high ? limits.lowMinutes : limits.highMinutes)) {
          high = !high;
          since = high ? now() : null;
          candidate = undefined;
        }
      } else {
        candidate = undefined;
      }
      last = { ...sample, high, since };
      return last;
    },
  };
}
