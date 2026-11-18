import { cp, lstat, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ProgramReport } from "@super-agent2/protocol";
import type { Prober } from "./programs.js";
import { newer } from "./program-update.js";

export async function selfUpdateFor(program: ProgramReport, prober: Prober, home = homedir()) {
  const path = program.path;
  if (path === null || program.version === null) return undefined;
  const executable = resolve(path);
  const localBin = resolve(home, ".local", "bin");
  let channel: string;
  let args: string[];
  if (program.id === "claude" && dirname(executable) === localBin && /^claude(?:\.exe)?$/i.test(basename(executable))) {
    const versions = resolve(home, ".local", "share", "claude", "versions");
    try {
      if (!(await stat(versions)).isDirectory()) return undefined;
      const file = await lstat(executable);
      if (file.isSymbolicLink()) {
        const target = await realpath(executable);
        if (!target.startsWith(`${await realpath(versions)}${sep}`)) return undefined;
      } else if (!/\.exe$/i.test(executable) || !file.isFile()) return undefined;
    } catch { return undefined; }
    channel = "Claude Code native";
    args = ["install", "stable"];
  } else if (program.id === "antigravity" && (
    (dirname(executable) === localBin && basename(executable) === "agy") ||
    resolve(executable).toLowerCase() === resolve(home, "AppData", "Local", "agy", "bin", "agy.exe").toLowerCase()
  )) {
    try { if (!(await lstat(executable)).isFile()) return undefined; } catch { return undefined; }
    channel = "Antigravity CLI";
    args = ["update"];
  } else return undefined;
  const installed = program.version;
  return {
    latest: null,
    channel,
    install: async () => {
      const backup = await mkdtemp(join(tmpdir(), "sa2-self-update-"));
      const saved = join(backup, "executable");
      try {
        await cp(executable, saved, { dereference: false, verbatimSymlinks: true });
        try {
          await prober.capture(executable, args);
          const output = await prober.capture(executable, ["--version"]);
          const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)/.exec(output)?.[1];
          if (version === undefined || version.includes("-") || (version !== installed && !newer(installed, version))) {
            throw new Error(`vendor updater returned an invalid, prerelease, or older version: ${version ?? output}`);
          }
        } catch (error) {
          const replacement = join(dirname(executable), `.sa2-restore-${process.pid}-${Date.now()}`);
          await cp(saved, replacement, { dereference: false, verbatimSymlinks: true });
          await rm(executable, { force: true });
          await rename(replacement, executable);
          throw error;
        }
      } finally { await rm(backup, { recursive: true, force: true }); }
    },
  };
}
