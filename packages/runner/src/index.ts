import { protocolVersion } from "@super-agent2/protocol";

export const part = "runner";

export function speaks(version: number): boolean {
  return version === protocolVersion;
}
