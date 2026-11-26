import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const command = process.argv[2];
if (command === "--version") {
  process.stdout.write("codex-cli 1.0.0\n");
} else if (command === "login" && process.argv[3] === "status") {
  if (process.env.FAKE_CODEX_SIGNED_OUT === "1") {
    process.stdout.write("Not logged in\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("Logged in using ChatGPT\n");
  }
} else if (command === "app-server") {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let threadId;
  let tools;
  let client;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const { id, method, params } = JSON.parse(line);
    if (method === "initialize") {
      client = params.clientInfo.name;
      write({ id, result: { userAgent: "local-smoke" } });
    } else if (method === "thread/start" || method === "thread/resume") {
      tools = params.config["mcp_servers.hub"];
      threadId = params.threadId ?? randomUUID();
      write({ id, result: { thread: { id: threadId } } });
    } else if (method === "turn/start") {
      const turnId = randomUUID();
      const prompt = params.input[0].text;
      write({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      if (client === "super-agent2-worker") {
        const handback = /^Hand back by writing the JSON file at: (.+)$/m.exec(prompt)?.[1];
        const output = /^Output folder: (.+)$/m.exec(prompt)?.[1];
        if (handback === undefined || output === undefined) throw new Error("The worker brief did not contain the hand-back and output paths");
        writeFileSync(join(output, "result.txt"), "Local smoke worker completed.");
        writeFileSync(join(output, "notes.txt"), "A file delivered without device transfer.");
        writeFileSync(handback, JSON.stringify({ report: { en: "Finished", zh: "\u5b8c\u6210" }, text: "result.txt", files: ["notes.txt"] }));
      } else if (prompt.includes("Launch the local smoke task")) {
        const request = (method, params) => fetch(tools.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env[tools.bearer_token_env_var]}`, ...tools.http_headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const listed = await (await request("tools/list", {})).json();
        const light = listed.result?.tools.find(({ name }) => name === "start_light_task");
        if (listed.result?.tools.some(({ name }) => name === "transfer_lookup" || name === "transfer_read")) throw new Error("Optional transfer tools were offered");
        if (JSON.stringify(light?.inputSchema).includes("agent_wring")) throw new Error("Agent_wring was offered without configuration");
        const response = await request("tools/call", { name: "start_light_task", arguments: {
            title: { en: "Local smoke task", zh: "\u672c\u5730\u4efb\u52a1" },
            summary: { en: "Exercise the local runner", zh: "\u6d4b\u8bd5\u672c\u5730\u8fd0\u884c\u5668" },
            task: "Return a short result.", kind: "writing", ownerEngine: "codex",
            reason: { en: "One short task", zh: "\u7b80\u77ed\u4efb\u52a1" },
        } });
        const reply = await response.json();
        if (!response.ok || reply.result?.isError !== false) throw new Error(`The smoke task was refused: ${JSON.stringify(reply)}`);
      }
      write({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "message", text: "Fake program replied." } } });
      write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    }
  }
}
