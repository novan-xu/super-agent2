import { runMachineCommand } from "./machine-commands.js";

process.exitCode = await runMachineCommand({
  argv: process.argv.slice(2),
  environment: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
