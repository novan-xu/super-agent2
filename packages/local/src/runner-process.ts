import { once } from "node:events";
import { runnerFiles, startRunnerService } from "@super-agent2/runner";
import { holdPresence } from "./presence.js";

const [home, mode] = process.argv.slice(2);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
process.once("disconnect", () => stop.abort());
process.on("message", (message) => { if (message === "stop") stop.abort(); });

async function main(): Promise<void> {
  if (home === undefined || process.send === undefined) throw new Error("Start the local runner through pnpm local");
  if (!process.connected) return;
  process.send("ready", (error) => { if (error) stop.abort(); });
  const release = await holdPresence(home, "runner");
  try {
    if (stop.signal.aborted || !process.connected) return;
    const service = await startRunnerService({
      checkSignIn: true,
      files: runnerFiles(home), environment: process.env, tokenOnly: mode === "--loopback",
      log: (line) => process.stdout.write(`Local runner: ${line}\n`),
    });
    if (service === undefined) throw new Error("The local runner could not start");
    try {
      if (!stop.signal.aborted) await once(stop.signal, "abort");
    } finally {
      await service.close();
    }
  } finally {
    await release();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Local runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
