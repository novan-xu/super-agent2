import { protocolVersion } from "@super-agent2/protocol";

export const part = "runner";

export function speaks(version: number): boolean {
  return version === protocolVersion;
}

export * from "./config.js";
export * from "./install.js";
export * from "./ledger.js";
export * from "./link.js";
export * from "./machine.js";
export * from "./programs.js";
export * from "./secret-file.js";
export * from "./service.js";
export * from "./setup.js";
export * from "./shell.js";
export * from "./brief.js";
export * from "./git.js";
export * from "./handback.js";
export * from "./identity.js";
export * from "./workplace.js";
export * from "./works.js";
export * from "./writing.js";
