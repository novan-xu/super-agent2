import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const built = ["local/dist/main.js", "local/dist/runner-process.js", "brain/dist/index.js", "hub/dist/index.js", "runner/dist/index.js", "programs/dist/index.js", "web/dist/index.html"];
const missing = built.filter((path) => !existsSync(join(checkout, "packages", path)));

async function launch() {
  const { stateFolder } = await import("./dist/settings.js");
  const home = stateFolder(process.env);
  const { holdPresence } = await import("./dist/presence.js");
  const release = await holdPresence(home, "launcher");
  const pending = join(home, "local-build-pending.json");
  const active = join(home, "local-build-active.json");
  const readCommit = (path) => {
    if (!existsSync(path)) return undefined;
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (entry?.checkout !== checkout) return undefined;
    if (typeof entry.commit !== "string" || !/^[0-9a-f]{40}$/.test(entry.commit)) {
      throw new Error(`The build selection at ${path} has no valid commit`);
    }
    return entry.commit;
  };
  let child;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (child?.connected) child.disconnect();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("disconnect", stop);
  try {
    if (process.send !== undefined && !process.connected) return;
    while (!stopping) {
      const next = readCommit(pending);
      const previous = readCommit(active);
      const commit = next ?? previous;
      const runtime = commit === undefined ? checkout : join(home, "local-builds", commit);
      const entry = join(runtime, "packages", "local", "dist", "main.js");
      let ready = false;
      let problem;
      child = fork(entry, next === undefined ? [checkout] : [checkout, next], { stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true, execArgv: [] });
      child.on("message", (message) => {
        if (next === undefined || message?.localBuildReady !== next || ready) return;
        try {
          renameSync(pending, active);
          ready = true;
          if (child.connected) child.send({ localBuildConfirmed: next, previous }, (error) => { if (error && child.connected) child.disconnect(); });
        } catch (error) {
          problem = error;
          if (child.connected) child.disconnect();
        }
      });
      const [code] = await once(child, "exit");
      child = undefined;
      if (stopping) return;
      if (next !== undefined && !ready) {
        rmSync(pending, { force: true });
        process.stderr.write(`The local edition could not start build ${next}${problem instanceof Error ? `: ${problem.message}` : ""}. Starting the previous build.\n`);
        continue;
      }
      if (code === 75 || readCommit(pending) !== undefined) continue;
      process.exitCode = code ?? 1;
      return;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("disconnect", stop);
    await release();
  }
}

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write("Super Agent requires Node.js 24 or later.\n");
  process.exitCode = 1;
} else if (missing.length > 0) {
  process.stderr.write(`Build output is missing (${missing.join(", ")}). Run corepack pnpm build first.\n`);
  process.exitCode = 1;
} else {
  try {
    await launch();
  } catch (error) {
    process.stderr.write(`Super Agent could not launch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
