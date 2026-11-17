import { execFile, spawn } from "node:child_process";

function waitFor(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true });
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

export function descendantsOf(root: number, table: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid <= 0) {
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(pid);
    children.set(parent, list);
  }
  const found: number[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    for (const child of children.get(next) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

function processTable(): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=", "-o", "ppid="], { windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : ""));
  });
}

function signal(pid: number, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    return;
  }
}

export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    await waitFor("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  const descendants = descendantsOf(pid, await processTable());
  signal(pid, true);
  signal(pid, false);
  for (const child of descendants) {
    signal(child, true);
    signal(child, false);
  }
}
