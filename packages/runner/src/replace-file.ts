import { renameSync, rmSync, writeFileSync } from "node:fs";

const transientCodes: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

export function replaceFile(temporary: string, target: string, content: string | Buffer, rename: (from: string, to: string) => void = renameSync): void {
  try {
    rename(temporary, target);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!transientCodes.has(code)) {
      throw error;
    }
    writeFileSync(target, content);
    rmSync(temporary, { force: true });
  }
}
