import { randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Brain, createBrain, createHubLink, type HubLink, prepareWorkspace, programAdapter, startingModels, systemClock } from "@super-agent2/brain";
import { fingerprintOf, type Hub, startHub } from "@super-agent2/hub";
import { type AccessKeySet, brainToolsPath, type ConversationEntry, type Provider, Provider as ProviderShape } from "@super-agent2/protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

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
const provider: Provider = failover ? "gpt" : ProviderShape.parse(process.argv[2] ?? "claude");
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
    credentialPaths: [],
    brainTokenFile: join(dataDir, "brain.token"),
  },
  keySource: () => Promise.resolve(keys),
});
const hubUrl = `http://127.0.0.1:${hub.address.port}`;
const token = readFileSync(join(dataDir, "brain.token"), "utf8").trim();

let brain: Brain | undefined;
let link: HubLink | undefined;

function startBrain(broken: readonly Provider[] = []): void {
  link = createHubLink({ hubUrl, token, report: (line) => process.stdout.write(`\n<link> ${line}\n`) });
  const order: readonly Provider[] = failover ? ["gpt", "claude", "deepseek"] : [provider];
  const adapters = new Map(
    order.map((name) => [
      name,
      programAdapter(name, {
        program: programs[name],
        model: broken.includes(name) ? `${name}-model-that-does-not-exist` : failover ? startingModels[name].model : model,
        effort: failover ? startingModels[name].effort : effort,
        environment: process.env,
        clock: systemClock,
      }),
    ]),
  );
  brain = createBrain({
    adapters,
    order,
    transport: link,
    clock: systemClock,
    tools: { url: `${hubUrl}${brainToolsPath}`, token },
    workspace,
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
  note("a message reaches the running turn", reply.includes("PINEAPPLE"), `turns: ${turns.length}; all taken: ${taken}; reply: ${reply.slice(-200)}`);
}

if (only.has("interrupt")) {
  const conversation = hub.conversations.create().id;
  hub.conversations.send(conversation, `用 run_command 在 hub 上运行：node -e "setTimeout(()=>console.log('done'),120000)"，等它结束后告诉我。`);
  await waitFor(() => entriesOf(conversation).some((entry) => entry.kind === "tool"));
  hub.conversations.interrupt(conversation);
  await turnsDone(conversation, 1);
  const turn = hub.conversations.detail(conversation)?.turns[0];
  note("an interrupt stops the turn", turn?.state === "interrupted", `turn: ${turn?.state} ${turn?.reason ?? ""}`);
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
  const stored = hub.memories.add(`记忆检查的暗号是 ${before}。`);
  if (!stored.ok) {
    throw new Error(stored.error);
  }
  const id = Math.max(...stored.list.memories.map((memory) => memory.id));
  const conversation = hub.conversations.create().id;
  const first = await ask(conversation, "记忆检查的暗号是什么？只回答暗号本身。", 1);
  const firstTools = entriesOf(conversation).filter((entry) => entry.kind === "tool").length;
  note("a new conversation has the memory", first.includes(before), `code word ${before}; tool calls: ${firstTools}; reply: ${first.slice(0, 200)}`);
  let after = word();
  while (after === before) {
    after = word();
  }
  const edited = hub.memories.edit(id, `记忆检查的暗号是 ${after}。`);
  if (!edited.ok) {
    throw new Error(edited.error);
  }
  const second = await ask(conversation, "现在记忆检查的暗号是什么？只回答暗号本身。", 2);
  note("the same session learns of the owner's edit", second.includes(after) && !second.includes(before), `code word now ${after}; reply: ${second.slice(0, 200)}`);
  const unchanged = hub.memories.list().find((candidate) => candidate.id === id)?.text === `记忆检查的暗号是 ${after}。`;
  note("the brain changed nothing itself", unchanged, `memory after the turn: ${JSON.stringify(hub.memories.list().find((candidate) => candidate.id === id))}; suggestions: ${JSON.stringify(hub.memories.suggestions())}`);
  hub.memories.remove(id);
}

if (only.has("preference")) {
  const conversation = hub.conversations.create().id;
  const told = await ask(conversation, "以后不管在哪段对话里，你回答我的最后一行都单独写「—— 完」。记住这一点。", 1);
  const suggestions = hub.memories.suggestions();
  note("a preference stated in Chinese is suggested, not stored", suggestions.length > 0 && hub.memories.list().length === 0, `suggestions: ${JSON.stringify(suggestions.map((suggestion) => suggestion.text))}; reply: ${told.slice(0, 200)}`);
  for (const suggestion of suggestions) {
    hub.memories.confirm(suggestion.id);
  }
  await stopBrain();
  startBrain();
  const later = hub.conversations.create().id;
  const reply = await ask(later, "1 加 1 等于几？", 1);
  const lines = reply.trim().split("\n");
  note("it is applied in a new conversation after a restart", (lines.at(-1) ?? "").includes("完"), `reply: ${reply.slice(-200)}`);
  for (const memory of hub.memories.list()) {
    hub.memories.remove(memory.id);
  }
}

if (only.has("failover")) {
  const conversation = hub.conversations.create().id;
  await ask(conversation, "记住：这次测试的暗号是 MANGO-23，只记在这段对话里，不要写文件。只回答“记住了”。", 1);
  const first = hub.conversations.detail(conversation)?.turns.at(-1);
  await stopBrain();
  startBrain(["gpt"]);
  const second = await ask(conversation, "我们这段对话的暗号是什么？", 2);
  const secondTurn = hub.conversations.detail(conversation)?.turns.at(-1);
  note(
    "Claude answers when GPT is unavailable",
    first?.provider === "gpt" && secondTurn?.provider === "claude" && second.includes("MANGO-23"),
    `first by ${first?.provider}; second by ${secondTurn?.provider}; reply: ${second.slice(0, 200)}`,
  );
  await stopBrain();
  startBrain(["gpt", "claude"]);
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
  note("GPT takes the conversation back", fourthTurn?.provider === "gpt" && fourth.includes("MANGO-23"), `fourth by ${fourthTurn?.provider}; reply: ${fourth.slice(0, 200)}`);
}

await stopBrain();
await hub.close();
process.stdout.write(`\n\nSummary for ${failover ? "failover" : `${provider} (${program}, ${model}, ${effort})`}:\n`);
for (const check of checks) {
  process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}\n`);
}
process.stdout.write(`State kept in ${root}\n`);
process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
