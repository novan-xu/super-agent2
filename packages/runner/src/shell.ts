import { type ChildProcess, spawn } from "node:child_process";

export function mergeEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  added: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(added)) {
    for (const existing of Object.keys(result)) {
      if (existing.toUpperCase() === name.toUpperCase()) {
        delete result[existing];
      }
    }
    result[name] = value;
  }
  return result;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return exited(killer);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return Promise.resolve();
    }
  }
  return Promise.resolve();
}
