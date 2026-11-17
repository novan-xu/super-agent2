import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Revision } from "@super-agent2/protocol";

export const revisionFile = ".revision";

export function checkoutOf(mainPath: string): string {
  return resolve(dirname(mainPath), "..", "..", "..");
}

export type ReadGitHead = (folder: string) => string | undefined;

export const gitHead: ReadGitHead = (folder) => {
  try {
    return execFileSync("git", ["-C", folder, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
};

export function runnerVersion(mainPath: string, readHead: ReadGitHead = gitHead): string | undefined {
  const folder = checkoutOf(mainPath);
  let written: string | undefined;
  try {
    written = readFileSync(join(folder, revisionFile), "utf8").trim();
  } catch {
    written = undefined;
  }
  const found = written ?? readHead(folder);
  return found !== undefined && Revision.safeParse(found).success ? found : undefined;
}
