import { accessSync, constants, mkdirSync, opendirSync, statSync } from "node:fs";
import { join } from "node:path";

const [root, ...parts] = process.argv.slice(2);
try {
  if (root === undefined || !statSync(root).isDirectory()) throw new Error("The artifacts path is not a folder");
  accessSync(root, constants.W_OK | constants.X_OK);
  if (parts.length === 0) {
    const directory = opendirSync(root);
    try {
      directory.readSync();
    } finally {
      directory.closeSync();
    }
  }
  let next = root;
  for (const part of parts) {
    next = join(next, part);
    try {
      mkdirSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !statSync(next).isDirectory()) throw error;
    }
  }
  if (parts.length > 0) accessSync(next, constants.W_OK | constants.X_OK);
} catch {
  process.exitCode = 1;
}
