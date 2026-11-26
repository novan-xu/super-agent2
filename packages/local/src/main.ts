import { once } from "node:events";
import { join } from "node:path";
import { startFromEnvironment as startBrain } from "@super-agent2/brain";
import { loadConfig, startFromEnvironment as startHub } from "@super-agent2/hub";
import { systemClock } from "@super-agent2/programs";
import { localCredentials } from "./credentials.js";
import { holdPresence } from "./presence.js";
import { commandShell, preflight } from "./preflight.js";
import { prepareRunner, runnerSettings, superviseRunner } from "./runner.js";
import { hubEnvironment, readLocalSettings, stateFolder } from "./settings.js";

const report = (line: string) => process.stdout.write(`${line}\n`);
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("disconnect", stop);

async function main(): Promise<void> {
  const home = stateFolder(process.env);
  const settings = readLocalSettings(home, process.env);
  if (settings === undefined) {
    report(`Created ${join(home, "local.env")}. Set PROJECTS_DIR and run corepack pnpm local again.`);
    return;
  }
  const { projects, env } = settings;
  const environment = hubEnvironment(home, env);
  const loaded = loadConfig(environment);
  if (!loaded.ok) throw new Error(loaded.problems.join("\n"));
  const { config } = loaded;
  const access = config.accessAudience !== undefined;
  if (access) runnerSettings("", true, env);
  const release = await holdPresence(home, "launcher");
  try {
    const credentials = localCredentials(environment);
    const hub = await startHub(environment, { credentials, commandShell: commandShell(environment), projectFolders: [projects], report });
    if (hub === undefined) throw new Error("The hub could not start");
    try {
      const address = hub.address.address;
      const host = hub.address.family === "IPv6" ? `[${address === "::" ? "::1" : address}]` : address === "0.0.0.0" ? "127.0.0.1" : address;
      const url = `http://${host}:${hub.address.port}`;
      const runner = runnerSettings(url, access, env);
      const runnerHome = join(home, "runner");
      const brainConfiguration = await preflight({
        ...environment,
        BRAIN_HUB_URL: url,
        BRAIN_TOKEN_FILE: config.brainTokenFile,
        BRAIN_WORKSPACE: join(home, "brain"),
        BRAIN_ATTACHMENTS_DIR: join(home, "brain", "attachments"),
      }, report);
      prepareRunner(hub, runnerHome, projects, runner, env);
      const brain = startBrain(brainConfiguration.environment, systemClock, report, brainConfiguration.available);
      if (brain === undefined) throw new Error("The brain could not start");
      try {
        const closeRunner = superviseRunner(runnerHome, runner.tokenOnly, env, report);
        try {
          report(`Super Agent is available at ${runner.url}/`);
          if (!shutdown.signal.aborted) await once(shutdown.signal, "abort");
        } finally {
          await closeRunner();
        }
      } finally {
        await brain.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    await release();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Super Agent could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  process.off("disconnect", stop);
}
