import { arch, hostname, release, userInfo } from "node:os";
import { type MachinePlatform, type MachineReport, type ProgramReport } from "@super-agent2/protocol";

export function platformOf(platform: NodeJS.Platform): MachinePlatform {
  if (platform === "win32" || platform === "darwin") {
    return platform;
  }
  return "linux";
}

export function machineReport(slots: number, programs: readonly ProgramReport[], platform: NodeJS.Platform = process.platform): MachineReport {
  return {
    hostname: hostname(),
    platform: platformOf(platform),
    release: release(),
    arch: arch(),
    user: userInfo().username,
    slots: { total: slots, free: slots },
    programs: [...programs],
  };
}
