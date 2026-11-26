import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { type MachineLoad } from "@super-agent2/protocol";
import { z } from "zod";

export const loadSampleInterval = 15_000;

interface ProcessTime {
  readonly pid: number;
  readonly parent: number;
  readonly milliseconds: number;
  readonly bornAt?: number;
}

interface HardwareLoad {
  readonly processes: readonly ProcessTime[] | null;
  readonly gpuPercent: number | null;
}

export type LoadCommand = (file: string, args: readonly string[], options: { windowsHide: true; timeout: number; maxBuffer: number }) => Promise<string>;

const run: LoadCommand = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout) => error === null ? resolve(stdout) : reject(error));
});

const windowsProbe = [
  "$ErrorActionPreference = 'Stop'",
  "$processes = $null",
  "try { $processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime | ForEach-Object {",
  "  $bornAt = if ($_.CreationDate) { ([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { -1 }",
  "  @{ pid = $_.ProcessId; parent = $_.ParentProcessId; bornAt = $bornAt; milliseconds = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000 }",
  "}) } catch {}",
  "$gpu = $null",
  "try { $gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage -OperationTimeoutSec 4 | ForEach-Object {",
  "  @{ name = $_.Name; utilization = $_.UtilizationPercentage }",
  "}) } catch {}",
  "@{ processes = $processes; gpu = $gpu } | ConvertTo-Json -Compress -Depth 4",
].join("\n");

const WindowsLoad = z.object({
  processes: z.array(z.object({ pid: z.number(), parent: z.number(), bornAt: z.number(), milliseconds: z.number() })).nullable(),
  gpu: z.array(z.object({ name: z.string(), utilization: z.number() })).nullable(),
});

function windowsGpu(engines: NonNullable<z.infer<typeof WindowsLoad>["gpu"]>): number | null {
  const totals = new Map<string, number>();
  for (const { name, utilization } of engines) {
    const key = /^pid_\d+_(luid_.+?_phys_\d+_eng_\d+)_/i.exec(name)?.[1];
    if (key !== undefined) totals.set(key, (totals.get(key) ?? 0) + utilization);
  }
  return engines.length === 0 ? 0 : totals.size === 0 ? null : Math.max(...totals.values());
}

function processTimes(output: string): ProcessTime[] {
  return output.split("\n").flatMap((line) => {
    const parts = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (parts === null) return [];
    const [, pid, parent, days = "0", hours = "0", minutes, seconds] = parts;
    const milliseconds = (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
    return [{ pid: Number(pid), parent: Number(parent), milliseconds }];
  });
}

export function hardwareLoad(platform: NodeJS.Platform, command: LoadCommand = run): () => Promise<HardwareLoad> {
  const read = (file: string, args: readonly string[]) => command(file, args, { windowsHide: true, timeout: 8_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => "");
  if (platform === "win32") {
    return async () => {
      const output = await read("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProbe]);
      try {
        const { processes, gpu } = WindowsLoad.parse(JSON.parse(output));
        return { processes, gpuPercent: gpu === null ? null : windowsGpu(gpu) };
      } catch {
        return { processes: null, gpuPercent: null };
      }
    };
  }

  return async () => {
    const mac = platform === "darwin";
    const [processes, gpu] = await Promise.all([
      mac ? read("/bin/ps", ["-S", "-axo", "pid=,ppid=,time="]) : read("ps", ["-axo", "pid=,ppid=,time="]),
      mac ? read("/usr/sbin/ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]) : "",
    ]);
    const utilization = [...gpu.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((match) => Number(match[1]));
    return { processes: processes === "" ? null : processTimes(processes), gpuPercent: utilization.length === 0 ? null : Math.max(...utilization) };
  };
}

function processTree(processes: readonly ProcessTime[] | null, root: number): Map<number, ProcessTime> | null {
  const runner = processes?.find(({ pid }) => pid === root);
  if (runner === undefined || processes === null) return null;
  const children = new Map<number, ProcessTime[]>();
  for (const entry of processes) {
    const group = children.get(entry.parent) ?? [];
    group.push(entry);
    children.set(entry.parent, group);
  }
  const tree = new Map([[root, runner]]);
  for (const [pid, parent] of tree) {
    for (const child of children.get(pid) ?? []) {
      if (!tree.has(child.pid) && (child.bornAt === undefined || parent.bornAt === undefined || child.bornAt >= parent.bornAt)) tree.set(child.pid, child);
    }
  }
  return tree;
}

function ownMilliseconds(before: Map<number, ProcessTime>, after: Map<number, ProcessTime>, reaped: boolean, since: number): number {
  if (reaped) {
    const total = (tree: Map<number, ProcessTime>) => [...tree.values()].reduce((sum, entry) => sum + entry.milliseconds, 0);
    return total(after) - total(before);
  }
  let milliseconds = 0;
  for (const [pid, current] of after) {
    const previous = before.get(pid);
    if (previous !== undefined && previous.bornAt === current.bornAt && current.milliseconds >= previous.milliseconds) {
      milliseconds += current.milliseconds - previous.milliseconds;
    } else if (current.bornAt === undefined || current.bornAt >= since) {
      milliseconds += current.milliseconds;
    }
  }
  return milliseconds;
}

function cpuTimes() {
  let total = 0;
  let idle = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { total, idle };
}

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

export function createLoadSampler(options: {
  readonly platform: NodeJS.Platform;
  readonly now?: () => number;
  readonly pid?: number;
  readonly cpu?: typeof cpuTimes;
  readonly hardware?: () => Promise<HardwareLoad>;
}): () => Promise<MachineLoad> {
  const now = options.now ?? Date.now;
  const cpu = options.cpu ?? cpuTimes;
  const hardware = options.hardware ?? hardwareLoad(options.platform);
  let previous: { at: number; times: ReturnType<typeof cpuTimes>; tree: ReturnType<typeof processTree> } | undefined;
  return async () => {
    const sampledAt = now();
    const times = cpu();
    const readings = await hardware();
    const tree = processTree(readings.processes, options.pid ?? process.pid);
    const before = previous;
    previous = { at: sampledAt, times, tree };
    const total = before === undefined ? 0 : times.total - before.times.total;
    const cpuPercent = before === undefined || total <= 0 ? null : percent(100 * (total - (times.idle - before.times.idle)) / total);
    const ownCpuPercent = before?.tree == null || tree === null || total <= 0 ? null
      : percent(100 * ownMilliseconds(before.tree, tree, options.platform === "darwin", before.at) / total);
    return { sampledAt, cpuPercent, ownCpuPercent, gpuPercent: readings.gpuPercent === null ? null : percent(readings.gpuPercent) };
  };
}

export function loadChanged(previous: MachineLoad | undefined, current: MachineLoad): boolean {
  return previous === undefined || current.sampledAt - previous.sampledAt >= 2 * loadSampleInterval
    || (["cpuPercent", "ownCpuPercent", "gpuPercent"] as const).some((metric) => {
      const before = previous[metric];
      const after = current[metric];
      return before === null || after === null ? before !== after : Math.abs(before - after) >= 1;
    });
}
