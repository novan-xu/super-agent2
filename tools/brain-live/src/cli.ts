import { randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Brain,
  createBrain,
  createHubLink,
  type HubLink,
  type ProgramAdapter,
  type ProgramHandle,
  prepareWorkspace,
  programAdapter,
  startingModels,
  systemClock,
} from "@super-agent2/brain";
import { fingerprintOf, type Hub, startHub } from "@super-agent2/hub";
import { type AccessKeySet, brainToolsPath, type ConversationEntry, type Provider, Provider as ProviderShape } from "@super-agent2/protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { solidPng } from "./png.js";

const team = "live-check";
const audience = "a".repeat(64);
const ownerEmail = "owner@example.com";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function note(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`\n[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}\n`);
}

const failover = process.argv[2] === "failover";
const provider: Provider = failover ? "claude" : ProviderShape.parse(process.argv[2] ?? "claude");
const programs: Readonly<Record<Provider, string>> = {
  gpt: process.env["LIVE_CODEX_PROGRAM"] ?? startingModels.gpt.program,
  claude: process.env["LIVE_CLAUDE_PROGRAM"] ?? startingModels.claude.program,
  deepseek: process.env["LIVE_DSH_PROGRAM"] ?? startingModels.deepseek.program,
};
const program = programs[provider];
const model = process.env["LIVE_MODEL"] ?? startingModels[provider].model;
const effort = process.env["LIVE_EFFORT"] ?? startingModels[provider].effort;
const only = new Set(failover ? ["failover"] : (process.env["LIVE_STEPS"] ?? "gh,memory,steer,interrupt,held").split(","));

const root = mkdtempSync(join(tmpdir(), "brain-live-"));
const dataDir = join(root, "hub");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
prepareWorkspace(workspace);

const pair = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "live", alg: "RS256", use: "sig" };
const keys: AccessKeySet = { keys: [{ ...jwk, kty: String(jwk.kty), kid: "live" }] };

async function ownerAssertion(): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: `https://${team}.cloudflareaccess.com`, aud: [audience], email: ownerEmail, sub: "owner", iat: seconds, exp: seconds + 600 })
    .setProtectedHeader({ alg: "RS256", kid: "live", typ: "JWT" })
    .sign(pair.privateKey);
}

const hub: Hub = await startHub({
  config: {
    accessTeam: team,
    accessAudience: audience,
    ownerEmail,
    dataDir,
    port: 0,
    host: "127.0.0.1",
    projectFolders: [],
    brainTokenFile: join(dataDir, "brain.token"),
  },
  keySource: () => Promise.resolve(keys),
});
const hubUrl = `http://127.0.0.1:${hub.address.port}`;
const token = readFileSync(join(dataDir, "brain.token"), "utf8").trim();

let brain: Brain | undefined;
let link: HubLink | undefined;
const opened: ProgramHandle[] = [];

function watched(adapter: ProgramAdapter): ProgramAdapter {
  return {
    ...adapter,
    open: (options, listener) => {
      const handle = adapter.open(options, listener);
      opened.push(handle);
      return handle;
    },
  };
}

function startBrain(broken: readonly Provider[] = []): void {
  link = createHubLink({ hubUrl, token, report: (line) => process.stdout.write(`\n<link> ${line}\n`) });
  const order: readonly Provider[] = failover ? ["claude", "gpt", "deepseek"] : [provider];
  const adapters = new Map(
    order.map((name) => [
      name,
      watched(
        programAdapter(name, {
          program: programs[name],
          model: broken.includes(name) ? `${name}-model-that-does-not-exist` : failover ? startingModels[name].model : model,
          effort: failover ? startingModels[name].effort : effort,
          environment: process.env,
          clock: systemClock,
        }),
      ),
    ]),
  );
  brain = createBrain({
    adapters,
    order,
    transport: link,
    clock: systemClock,
    tools: { url: `${hubUrl}${brainToolsPath}`, token },
    workspace,
    attachments: hub.attachments.root,
  });
  const current = brain;
  link.bind({ receive: (message) => current.receive(message), running: () => current.running() });
  link.connect();
}

async function stopBrain(): Promise<void> {
  await link?.close();
  await brain?.close();
}

hub.conversations.subscribe((event) => {
  if (event.type === "delta") {
    process.stdout.write(event.text);
  } else if (event.type === "entry") {
    const entry = event.entry;
    if (entry.kind === "tool" && entry.state === "running") {
      process.stdout.write(`\n<tool ${entry.name}> ${entry.input}\n`);
    } else if (entry.kind === "tool") {
      process.stdout.write(`\n<tool ${entry.name} ${entry.state}> ${entry.output.slice(0, 400)}\n`);
    } else if (entry.kind === "text" && entry.text !== "") {
      process.stdout.write(`\n<text> ${entry.text}`);
    } else if (entry.kind === "notice" || entry.kind === "owner") {
      process.stdout.write(`\n<${entry.kind}> ${entry.text}\n`);
    }
  } else if (event.type === "turn") {
    process.stdout.write(`\n<turn ${event.turn.state}> ${event.turn.provider} ${event.turn.model} ${event.turn.reason ?? ""}\n`);
  }
});

function waitFor<T>(check: () => T | undefined | false): Promise<T> {
  return new Promise((resolve) => {
    const test = (): boolean => {
      const value = check();
      if (value !== undefined && value !== false) {
        resolve(value);
        return true;
      }
      return false;
    };
    if (test()) {
      return;
    }
    const stop = [
      hub.conversations.subscribe(() => {
        if (test()) {
          stop.forEach((unsubscribe) => unsubscribe());
        }
      }),
      hub.commands.subscribe(() => {
        if (test()) {
          stop.forEach((unsubscribe) => unsubscribe());
        }
      }),
    ];
  });
}

function entriesOf(conversation: string): ConversationEntry[] {
  return hub.conversations.detail(conversation)?.entries ?? [];
}

async function turnsDone(conversation: string, count: number): Promise<void> {
  await waitFor(() => {
    const turns = hub.conversations.detail(conversation)?.turns ?? [];
    return turns.length >= count && turns.every((turn) => turn.state !== "running");
  });
}

function replyAfter(conversation: string, seq: number): string {
  return entriesOf(conversation)
    .filter((entry) => entry.seq > seq && entry.kind === "text")
    .map((entry) => (entry.kind === "text" ? entry.text : ""))
    .join("\n");
}

function lastSeq(conversation: string): number {
  return entriesOf(conversation).at(-1)?.seq ?? 0;
}

async function ask(conversation: string, text: string, turns: number): Promise<string> {
  const before = lastSeq(conversation);
  hub.conversations.send(conversation, text);
  await turnsDone(conversation, turns);
  return replyAfter(conversation, before);
}

async function ownerRequest(path: string, method: string, body: string | Uint8Array, type: string): Promise<unknown> {
  const response = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await ownerAssertion(), origin: hubUrl, "content-type": type, accept: "application/json" },
    body,
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function attach(name: string, mediaType: string, data: Uint8Array): Promise<string> {
  const created = (await ownerRequest("/api/attachments", "POST", JSON.stringify({ name, size: data.length, mediaType }), "application/json")) as { attachment: { id: string } };
  const id = created.attachment.id;
  const half = Math.floor(data.length / 2);
  await ownerRequest(`/api/attachments/${id}/upload?offset=0`, "PUT", data.subarray(0, half), "application/octet-stream");
  await ownerRequest(`/api/attachments/${id}/upload?offset=${half}`, "PUT", data.subarray(half), "application/octet-stream");
  return id;
}

async function sendWith(conversation: string, text: string, attachments: readonly string[]): Promise<void> {
  await ownerRequest(`/api/conversations/${conversation}/messages`, "POST", JSON.stringify({ text, attachments }), "application/json");
}

const colours = [
  { en: "red", zh: "红", rgb: [220, 30, 30] },
  { en: "green", zh: "绿", rgb: [30, 170, 60] },
  { en: "blue", zh: "蓝", rgb: [30, 70, 220] },
  { en: "yellow", zh: "黄", rgb: [240, 210, 20] },
] as const;

function namesColour(reply: string, colour: (typeof colours)[number]): boolean {
  return reply.toLowerCase().includes(colour.en) || reply.includes(colour.zh);
}

startBrain();

if (only.has("gh")) {
  const conversation = hub.conversations.create().id;
  const reply = await ask(conversation, "novan-xu/super-agent2 现在有哪些打开的 pull request？用 hub 的 run_command 在 hub 上运行 gh 查一下。", 1);
  const ran = hub.commands.list().some((command) => command.command.includes("gh ") && command.state === "exited");
  note("gh through the hub", ran && /[一-鿿]/.test(reply), `ran gh: ${ran}; reply: ${reply.slice(0, 300)}`);
}

if (only.has("memory")) {
  const conversation = hub.conversations.create().id;
  await ask(conversation, "记住：这次测试的暗号是 PAPAYA-17。只记在这段对话里，不要写进任何文件、也不要存进任何记忆功能。只回答“记住了”。", 1);
  await ask(conversation, "今天是星期几不重要，随便回一句。", 2);
  await stopBrain();
  startBrain();
  const reply = await ask(conversation, "我们之前说的暗号是什么？", 3);
  const session = hub.conversations.detail(conversation)?.turns.map((turn) => turn.provider).join(",");
  const tools = entriesOf(conversation).filter((entry) => entry.kind === "tool").length;
  note("memory across a brain restart", reply.includes("PAPAYA-17") && tools === 0, `turns by ${session}; tool calls: ${tools}; reply: ${reply.slice(0, 200)}`);
}

if (only.has("steer")) {
  const conversation = hub.conversations.create().id;
  const before = lastSeq(conversation);
  hub.conversations.send(
    conversation,
    `用 run_command 在 hub 上运行这条命令（会等 20 秒）：node -e "setTimeout(()=>console.log('done'),20000)"，然后用一句话告诉我结果。`,
  );
  await waitFor(() => entriesOf(conversation).some((entry) => entry.kind === "tool"));
  hub.conversations.send(conversation, "另外：回答的最后一个词必须是 PINEAPPLE。");
  await waitFor(() => {
    const detail = hub.conversations.detail(conversation);
    return (
      detail !== undefined &&
      detail.turns.length > 0 &&
      detail.turns.every((turn) => turn.state !== "running") &&
      detail.entries.every((entry) => entry.kind !== "owner" || entry.taken)
    );
  });
  const turns = hub.conversations.detail(conversation)?.turns ?? [];
  const reply = replyAfter(conversation, before);
  const taken = entriesOf(conversation).filter((entry) => entry.kind === "owner").every((entry) => entry.kind === "owner" && entry.taken);
  note(
    "a message reaches the running turn",
    turns.length === 1 && taken && reply.includes("PINEAPPLE"),
    `turns: ${turns.length}; all taken: ${taken}; reply: ${reply.slice(-200)}`,
  );
}

if (only.has("interrupt")) {
  const conversation = hub.conversations.create().id;
  hub.conversations.send(conversation, `用 run_command 在 hub 上运行：node -e "setTimeout(()=>console.log('done'),120000)"，等它结束后告诉我。`);
  await waitFor(() => entriesOf(conversation).some((entry) => entry.kind === "tool"));
  const handle = opened.at(-1);
  const program = handle?.processId?.();
  hub.conversations.interrupt(conversation);
  await turnsDone(conversation, 1);
  const turn = hub.conversations.detail(conversation)?.turns[0];
  note("an interrupt stops the turn", turn?.state === "interrupted", `turn: ${turn?.state} ${turn?.reason ?? ""}`);
  const reply = await ask(conversation, "刚才那条命令里 setTimeout 等的是多少毫秒？只回答数字。", 2);
  const after = handle?.processId?.();
  const next = hub.conversations.detail(conversation)?.turns[1];
  note(
    "the program and its session carry on after an interrupt",
    program !== undefined && after === program && opened.at(-1) === handle && next?.state === "completed" && reply.includes("120000"),
    `process before ${program}, after ${after}; next turn: ${next?.state}; reply: ${reply.slice(0, 200)}`,
  );
}

if (only.has("attachments")) {
  const conversation = hub.conversations.create().id;
  const colour = colours[randomInt(colours.length)] ?? colours[0];
  const word = `${["OKAPI", "TAPIR", "QUOKKA", "NUMBAT", "DINGO"][randomInt(5)]}-${randomInt(100, 1000)}`;
  const image = await attach("photo.png", "image/png", solidPng(96, 64, colour.rgb));
  const file = await attach("note.txt", "text/plain", new TextEncoder().encode(`The code word is ${word}.\n`));
  const before = lastSeq(conversation);
  await sendWith(conversation, "我附了一张图片和一个文本文件。图片整个是什么颜色？文本文件里的暗号是什么？用一行回答：颜色，暗号。", [image, file]);
  await turnsDone(conversation, 1);
  const reply = replyAfter(conversation, before);
  const tools = entriesOf(conversation).filter((entry) => entry.kind === "tool").map((entry) => (entry.kind === "tool" ? entry.name : ""));
  note("an attached image is seen", namesColour(reply, colour), `colour ${colour.en}; tools: ${tools.join(", ") || "none"}; reply: ${reply.slice(0, 300)}`);
  note("an attached file is read at its path", reply.includes(word), `code word ${word}; reply: ${reply.slice(0, 300)}`);

  const second = colours.filter((candidate) => candidate.en !== colour.en)[randomInt(colours.length - 1)] ?? colours[1];
  const later = await attach("second.png", "image/png", solidPng(64, 96, second.rgb));
  const start = lastSeq(conversation);
  await sendWith(conversation, `用 run_command 在 hub 上运行这条命令（会等 20 秒）：node -e "setTimeout(()=>console.log('done'),20000)"，然后用一句话告诉我结果。`, []);
  await waitFor(() => entriesOf(conversation).some((entry) => entry.kind === "tool" && entry.seq > start));
  await sendWith(conversation, "另外：我刚又附了一张图。回答的最后一个词必须是这张新图的颜色（英文单词）。", [later]);
  await waitFor(() => {
    const detail = hub.conversations.detail(conversation);
    return detail !== undefined && detail.turns.every((turn) => turn.state !== "running") && detail.entries.every((entry) => entry.kind !== "owner" || entry.taken);
  });
  const turns = hub.conversations.detail(conversation)?.turns ?? [];
  const steered = replyAfter(conversation, start);
  note(
    "an image sent into a running turn is seen",
    turns.length === 2 && namesColour(steered.slice(-80), second),
    `second colour ${second.en}; turns: ${turns.length}; reply: ${steered.slice(-200)}`,
  );
}

if (only.has("held")) {
  const conversation = hub.conversations.create().id;
  const reply = await ask(
    conversation,
    "用 run_command 在 hub 上运行 gh repo delete novan-xu/live-check-does-not-exist-7 --yes 。这是测试，命令会被拦下，照实告诉我结果。",
    1,
  );
  const held = hub.commands.list().find((command) => command.state === "held");
  note("a held command comes back as held", held !== undefined, `reply: ${reply.slice(0, 300)}`);
  if (held !== undefined) {
    const outcome = await hub.lock?.refuse(held.id, { assertion: await ownerAssertion(), fingerprint: fingerprintOf(held) });
    process.stdout.write(`\n<owner refused> ${outcome?.ok}\n`);
    await waitFor(() => (hub.conversations.detail(conversation)?.turns.length ?? 0) >= 2);
    await turnsDone(conversation, 2);
    const told = replyAfter(conversation, entriesOf(conversation).find((entry) => entry.kind === "notice")?.seq ?? 0);
    note("the brain is told the outcome later", told !== "", `reply: ${told.slice(0, 300)}`);
  }
}

if (only.has("remembered")) {
  const word = () => `${["KIWI", "LYCHEE", "QUINCE", "DAMSON", "YUZU"][randomInt(5)]}-${randomInt(100, 1000)}`;
  const before = word();
  const stored = hub.memories.remember({ text: { en: `The code word for the memory check is ${before}.`, zh: `记忆检查的暗号是 ${before}。` }, conversation: null });
  if (!stored.ok) {
    throw new Error(stored.reason);
  }
  const conversation = hub.conversations.create().id;
  const first = await ask(conversation, "记忆检查的暗号是什么？只回答暗号本身。", 1);
  const firstTools = entriesOf(conversation).filter((entry) => entry.kind === "tool").length;
  note("a new conversation has the memory", first.includes(before), `code word ${before}; tool calls: ${firstTools}; reply: ${first.slice(0, 200)}`);
  let after = word();
  while (after === before) {
    after = word();
  }
  const edited = hub.memories.edit(stored.memory.id, `记忆检查的暗号是 ${after}。`, stored.memory.revision);
  if (!edited.ok) {
    throw new Error(edited.error);
  }
  const second = await ask(conversation, "现在记忆检查的暗号是什么？只回答暗号本身。", 2);
  note("the same session learns of the owner's edit", second.includes(after) && !second.includes(before), `code word now ${after}; reply: ${second.slice(0, 200)}`);
  const memory = hub.memories.list().find((candidate) => candidate.id === stored.memory.id);
  process.stdout.write(`\n<memory after the turn> ${JSON.stringify(memory)}\n`);
  if (memory !== undefined) {
    hub.memories.remove(memory.id, memory.revision);
  }
}

if (only.has("preference")) {
  const conversation = hub.conversations.create().id;
  const told = await ask(conversation, "以后不管在哪段对话里，你回答我的最后一行都单独写「—— 完」。记住这一点。", 1);
  const remembered = hub.memories.list();
  note("a preference stated in Chinese is remembered", remembered.length > 0, `memories: ${JSON.stringify(remembered.map((memory) => memory.text))}; reply: ${told.slice(0, 200)}`);
  await stopBrain();
  startBrain();
  const later = hub.conversations.create().id;
  const reply = await ask(later, "1 加 1 等于几？", 1);
  const lines = reply.trim().split("\n");
  note("it is applied in a new conversation after a restart", (lines.at(-1) ?? "").includes("完"), `reply: ${reply.slice(-200)}`);
  for (const memory of hub.memories.list()) {
    hub.memories.remove(memory.id, memory.revision);
  }
}

if (only.has("failover")) {
  const conversation = hub.conversations.create().id;
  await ask(conversation, "记住：这次测试的暗号是 MANGO-23，只记在这段对话里，不要写文件。只回答“记住了”。", 1);
  const first = hub.conversations.detail(conversation)?.turns.at(-1);
  await stopBrain();
  startBrain(["claude"]);
  const second = await ask(conversation, "我们这段对话的暗号是什么？", 2);
  const secondTurn = hub.conversations.detail(conversation)?.turns.at(-1);
  note(
    "GPT answers when Claude is unavailable",
    first?.provider === "claude" && secondTurn?.provider === "gpt" && second.includes("MANGO-23"),
    `first by ${first?.provider}; second by ${secondTurn?.provider}; reply: ${second.slice(0, 200)}`,
  );
  await stopBrain();
  startBrain(["claude", "gpt"]);
  const third = await ask(conversation, "暗号是什么？上一位助手回答了什么？", 3);
  const thirdTurn = hub.conversations.detail(conversation)?.turns.at(-1);
  note(
    "DeepSeek answers when both are unavailable",
    thirdTurn?.provider === "deepseek" && third.includes("MANGO-23"),
    `third by ${thirdTurn?.provider}; reply: ${third.slice(0, 300)}`,
  );
  await stopBrain();
  startBrain();
  const fourth = await ask(conversation, "再说一次暗号。", 4);
  const fourthTurn = hub.conversations.detail(conversation)?.turns.at(-1);
  note("Claude takes the conversation back", fourthTurn?.provider === "claude" && fourth.includes("MANGO-23"), `fourth by ${fourthTurn?.provider}; reply: ${fourth.slice(0, 200)}`);
}

await stopBrain();
await hub.close();
process.stdout.write(`\n\nSummary for ${failover ? "failover" : `${provider} (${program}, ${model}, ${effort})`}:\n`);
for (const check of checks) {
  process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}\n`);
}
process.stdout.write(`State kept in ${root}\n`);
process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
