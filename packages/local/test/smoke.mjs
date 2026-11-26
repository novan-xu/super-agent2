import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const entry = fileURLToPath(new URL("../start.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const pathOf = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function launch(env) {
  const child = fork(entry, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, execArgv: [] });
  const closed = once(child, "close");
  const exited = once(child, "exit");
  let output = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => { output += `${line}\n`; });
  const untilLine = (match) => Promise.race([
    new Promise((resolve) => {
      const read = (line) => {
        const found = match.exec(line);
        if (found === null) return;
        lines.off("line", read);
        resolve(found[1]);
      };
      lines.on("line", read);
    }),
    closed.then(([code]) => { throw new Error(`The launcher exited with ${code}\n${output}`); }),
  ]);
  return {
    address: untilLine,
    closed,
    get output() { return output; },
    close: async () => {
      if (child.connected) child.disconnect();
      const [code] = await exited;
      child.stdout.destroy();
      child.stderr.destroy();
      assert.equal(code, 0, output);
    },
  };
}

function live(url) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}ws`);
  const messages = [];
  const waiting = new Set();
  socket.addEventListener("message", ({ data }) => {
    messages.push(JSON.parse(data));
    for (const wake of waiting) wake();
  });
  return {
    socket,
    wait: (match) => new Promise((resolve, reject) => {
      const closed = () => { waiting.delete(wake); reject(new Error("The hub socket closed")); };
      const wake = () => {
        const found = messages.find(match);
        if (found === undefined) return;
        waiting.delete(wake);
        socket.removeEventListener("close", closed);
        resolve(found);
      };
      socket.addEventListener("close", closed, { once: true });
      waiting.add(wake);
      wake();
    }),
  };
}

test("the pnpm local entry starts all parts, runs a worker and reopens the same state", async () => {
  const root = mkdtempSync(join(tmpdir(), "super-agent2-smoke-"));
  const home = join(root, "home");
  const projects = join(root, "my projects");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(projects);
  writeFileSync(join(bin, windows ? "codex.cmd" : "codex"), windows
    ? `@set "dp0=%~dp0"\r\n@"${process.execPath}" "%dp0%\\fake.mjs" %*\r\n`
    : `#!/bin/sh\nexec ${pathOf(process.execPath)} ${pathOf(fake)} "$@"\n`, { mode: 0o700 });
  if (windows) writeFileSync(join(bin, "fake.mjs"), readFileSync(fake));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|ComSpec|TEMP|TMP|LOCALAPPDATA|USERPROFILE|HOME|PATHEXT|APPDATA)$/i.test(name)));
  env.PATH = [bin, dirname(process.execPath), ...(windows ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"])].join(delimiter);
  env.SUPERAGENT2_HOME = home;
  let running;
  let connection;
  try {
    const first = launch(env);
    await first.closed;
    await first.close();
    assert.match(first.output, /Created .*local\.env/);
    writeFileSync(join(home, "local.env"), [
      `PROJECTS_DIR="${projects}"`, "PORT=0", "BRAIN_PROVIDERS=gpt", "HUB_ROUTING_PRIMARY=bigram",
      "RUNNER_MODELS_CODEX=gpt-6.1-terra:high,gpt-6-luna:medium", "SUPERAGENT2_PROGRAM_AUTO_UPDATE=0", "",
    ].join("\n"));
    running = launch(env);
    const url = await running.address(/^Super Agent is available at (.*)$/);
    assert.equal((await fetch(url)).status, 200);
    connection = live(url);
    await connection.wait((message) => message.type === "brain" && message.brain.linked);
    await connection.wait((message) => message.type === "settings" && message.settings.machines.some((machine) => machine.name === "local"
      && machine.online && machine.report?.programs.some((program) => program.id === "codex" && program.version === "1.0.0")));
    connection.socket.send(JSON.stringify({ type: "watch.stream", scope: { kind: "daily" } }));
    await connection.wait((message) => message.type === "stream.page");
    const post = (path, body) => fetch(new URL(path, url), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body),
    });
    const created = await post("api/conversations", {});
    assert.equal(created.status, 201);
    const { conversation } = await created.json();
    assert.equal((await post(`api/conversations/${conversation.id}/messages`, { text: "Launch the local smoke task" })).status, 202);
    const result = await connection.wait((message) => message.type === "stream.entry" && (
      message.entry.text === "Local smoke worker completed." || message.entry.text?.includes("The smoke task was refused")
    ));
    assert.equal(result.entry.text, "Local smoke worker completed.");
    const tokens = [join(home, "hub", "brain.token"), join(home, "runner", "runner.env")];
    const saved = tokens.map((file) => readFileSync(file, "utf8"));
    connection.socket.close();
    await running.close();
    running = launch(env);
    const restarted = await running.address(/^Super Agent is available at (.*)$/);
    const restored = await fetch(new URL(`api/conversations/${conversation.id}`, restarted));
    assert.equal(restored.status, 200);
    assert.match(await restored.text(), /Local smoke worker completed\./);
    assert.equal(readFileSync(tokens[0], "utf8"), saved[0]);
    assert.equal(/^RUNNER_TOKEN=.*$/m.exec(readFileSync(tokens[1], "utf8"))?.[0], /^RUNNER_TOKEN=.*$/m.exec(saved[1])?.[0]);
  } finally {
    connection?.socket.close();
    try { await running?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
