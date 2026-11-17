import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";

export type Execute = (program: string, args: readonly string[]) => void;

export const executeQuietly: Execute = (program, args) => {
  execFileSync(program, [...args], { stdio: "ignore", windowsHide: true });
};

export function restrictToUser(path: string, platform: NodeJS.Platform, execute: Execute): void {
  if (platform === "win32") {
    execute("icacls", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`]);
    return;
  }
  chmodSync(path, 0o600);
}

export function writeSecretFile(path: string, content: string, platform: NodeJS.Platform = process.platform, execute: Execute = executeQuietly): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.new`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  try {
    restrictToUser(temporary, platform, execute);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
