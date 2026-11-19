import { execFileSync } from "node:child_process";
import { run } from "./report.js";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const result = run(root);

for (const line of result.lines) {
  if (result.exitCode === 0) {
    console.log(line);
  } else {
    console.error(line);
  }
}
process.exitCode = result.exitCode;
