import { existsSync } from "node:fs";

const built = ["local/dist/main.js", "local/dist/runner-process.js", "brain/dist/index.js", "hub/dist/index.js", "runner/dist/index.js", "programs/dist/index.js", "web/dist/index.html"];
const missing = built.filter((path) => !existsSync(new URL(`../${path}`, import.meta.url)));

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write("Super Agent requires Node.js 24 or later.\n");
  process.exitCode = 1;
} else if (missing.length > 0) {
  process.stderr.write(`Build output is missing (${missing.join(", ")}). Run corepack pnpm build first.\n`);
  process.exitCode = 1;
} else {
  await import("./dist/main.js");
}
