import { execFileSync } from "node:child_process";
import { checkRepository } from "./repository.js";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const { checked, lines } = checkRepository(root);
if (lines.length) {
  for (const line of lines) console.error(line);
  console.error(`${lines.length} sentence finding(s) in ${checked} checked file(s).`);
  process.exitCode = 1;
} else {
  console.log(`Sentence lines checked in ${checked} file(s).`);
}
