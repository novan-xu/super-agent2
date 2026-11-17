import { protocolVersion } from "@super-agent2/protocol";

export const part = "hub";

export function speaks(version: number): boolean {
  return version === protocolVersion;
}
