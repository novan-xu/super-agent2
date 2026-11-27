import { once } from "node:events";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFromEnvironment as startBrain } from "@super-agent2/brain";
import { loadConfig, startFromEnvironment as startHub } from "@super-agent2/hub";
import { systemClock } from "@super-agent2/programs";
import { discardBuild, fastForwardCheckout, readLocalSource, stageRestart, verifyPendingBuild } from "./local-build.js";
import { localCredentials } from "./credentials.js";
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
  const running = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const checkout = process.argv[2] ?? running;
  const pending = process.argv[3];
  const source = await readLocalSource(checkout, running, environment);
  if (pending !== undefined) {
    if (source === undefined) throw new Error(`The local edition could not identify its checkout for ${pending}`);
    await verifyPendingBuild(source, home, pending, environment);
  }
  const restart = (commit: string) => {
    if (shutdown.signal.aborted || !process.connected) throw new Error("The local launcher is stopping");
    stageRestart(home, checkout, commit);
    process.exitCode = 75;
    shutdown.abort();
  };
  const loaded = loadConfig(environment);
  if (!loaded.ok) throw new Error(loaded.problems.join("\n"));
  const { config } = loaded;
  const access = config.accessAudience !== undefined;
  if (access) runnerSettings("", true, env);
  const credentials = localCredentials(environment);
  const hub = await startHub(environment, {
    credentials, commandShell: commandShell(environment), projectFolders: [projects], report,
    ...(source === undefined ? {} : { localInstallation: { ...source, restart } }),
  });
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
      const closeRunner = superviseRunner(runnerHome, runner.tokenOnly, env, report, source?.checkout);
      try {
        if (pending !== undefined && source !== undefined && !shutdown.signal.aborted) {
          await fastForwardCheckout(source, home, pending, environment);
          const confirmed = (message: unknown) => {
            if (typeof message === "object" && message !== null && "localBuildConfirmed" in message && message.localBuildConfirmed === pending) {
              hub.taskTickets.ready();
              if ("previous" in message && typeof message.previous === "string" && message.previous !== pending) {
                void discardBuild(home, checkout, message.previous, environment).catch((error) => report(String(error)));
              }
              process.off("message", confirmed);
            }
          };
          process.on("message", confirmed);
          process.send?.({ localBuildReady: pending }, (error) => { if (error) stop(); });
        } else {
          hub.taskTickets.ready();
        }
        if (source !== undefined) report(`Super Agent is running commit ${source.commit}.`);
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
  if (process.connected) process.disconnect();
}
