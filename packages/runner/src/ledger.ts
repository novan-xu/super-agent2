import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { replaceFile } from "./replace-file.js";
import { killTree } from "./shell.js";

const LedgerFile = z.object({
  boot: z.number(),
  pids: z.array(z.number().int().positive()),
});

export interface Ledger {
  add(pid: number): void;
  remove(pid: number): void;
  cleanup(): Promise<number[]>;
}

export interface LedgerOptions {
  readonly path: string;
  readonly boot?: () => number;
  readonly kill?: (pid: number) => Promise<void>;
}

export const sameBootTolerance = 120000;

export function bootTime(): number {
  return Date.now() - uptime() * 1000;
}

export function createLedger(options: LedgerOptions): Ledger {
  const boot = options.boot ?? bootTime;
  const kill = options.kill ?? ((pid: number) => killTree(pid));
  const pids = new Set<number>();
  const save = () => {
    mkdirSync(dirname(options.path), { recursive: true });
    const temporary = `${options.path}.new`;
    const content = JSON.stringify({ boot: boot(), pids: [...pids] });
    writeFileSync(temporary, content);
    replaceFile(temporary, options.path, content);
  };
  const read = (): z.infer<typeof LedgerFile> | undefined => {
    try {
      const parsed = LedgerFile.safeParse(JSON.parse(readFileSync(options.path, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    add: (pid) => {
      pids.add(pid);
      save();
    },
    remove: (pid) => {
      if (pids.delete(pid)) {
        save();
      }
    },
    cleanup: async () => {
      const previous = read();
      const killed: number[] = [];
      if (previous !== undefined && Math.abs(previous.boot - boot()) < sameBootTolerance) {
        for (const pid of previous.pids) {
          if (!pids.has(pid)) {
            await kill(pid);
            killed.push(pid);
          }
        }
      }
      save();
      return killed;
    },
  };
}
