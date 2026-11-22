import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, conversationHeader, type RunningTurn, turnHeader } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppGateway } from "./app-gateway.js";
import type { Hub } from "./hub.js";
import { testConfig } from "./testing/access.js";
import { attachBrain, requestBrainTool, startToolTurn } from "./testing/brain-tools.js";
import { scriptFile } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

const fakeAppServer = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync("rpc.log", JSON.stringify({ pid: process.pid, method: "process" }) + "\\n");
let threads = 0;
const links = [{ link_id: "outlook-a", profile_email: "first@example.com" }, { link_id: "outlook-b", profile_email: "second@example.com" }];
const names = [
  "gmail.search_emails", "gmail.read_email",
  "microsoft_outlook_email.list_messages", "microsoft_outlook_email.search_messages", "microsoft_outlook_email.fetch_message",
  "microsoft_outlook_email.list_attachments", "microsoft_teams.list_chats", "microsoft_teams.list_chat_messages",
  "microsoft_teams.list_teams", "microsoft_teams.list_channels", "microsoft_teams.list_channel_messages",
  "microsoft_teams.search", "ticktick_to_do_list_calendar.list_projects", "ticktick_to_do_list_calendar.search_task",
  "gmail.send_email", "microsoft_outlook_email.reply_to_email", "microsoft_teams.send_chat_message",
];
const tools = Object.fromEntries(names.map((name) => [name, {
  name, annotations: { readOnlyHint: name !== "microsoft_teams.search" || !existsSync("misclassified") },
  inputSchema: { properties: name.startsWith("microsoft_outlook_email.") ? { link_id: { type: "string" } } : {} },
  _meta: name.startsWith("microsoft_outlook_email.") ? { link_accounts: links } : { link_id: "connection" },
}]));
const mail = { id: "message-1", subject: "Private mail subject", receivedDateTime: "2026-11-21T10:00:00Z", sender: { emailAddress: { address: "sender@example.com" } } };
const content = {
  "gmail.search_emails": { emails: [{ id: "gmail-1", from_: "Gmail sender", snippet: "Private Gmail snippet", email_ts: "2026-11-21T09:00:00Z" }], next_page_token: "page-2" },
  "gmail.read_email": { email: { id: "gmail-1", payload: { parts: [{ mime_type: "text/plain", content: "Private Gmail body" }, { filename: "private.txt", content: "Secret attachment bytes" }] } } },
  "microsoft_outlook_email.list_messages": { value: [mail], next_from_index: 20 },
  "microsoft_outlook_email.search_messages": { results: [mail], next_from_index: null },
  "microsoft_outlook_email.fetch_message": { ...mail, body: { content: "A".repeat(8000) + "End of private mail" }, has_attachments: true },
  "microsoft_outlook_email.list_attachments": { value: [{ name: "invoice.pdf", contentBytes: "Secret attachment bytes" }] },
  "microsoft_teams.list_chats": { chats: [{ id: "chat-1", last_message_at: "2026-11-21T10:00:00Z" }] },
  "microsoft_teams.list_chat_messages": { messages: [{ id: "teams-1", content: "Private Teams message" }] },
  "microsoft_teams.list_teams": { teams: [{ id: "team-1" }] },
  "microsoft_teams.list_channels": { channels: [{ id: "channel-1" }] },
  "microsoft_teams.list_channel_messages": { messages: [{ id: "channel-message-1" }] },
  "microsoft_teams.search": { results: [{ message_id: "search-hit-1" }] },
  "ticktick_to_do_list_calendar.list_projects": { result: [{ id: "project-1" }] },
  "ticktick_to_do_list_calendar.search_task": { result: [{ id: "todo-1" }] },
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  appendFileSync("rpc.log", JSON.stringify({ pid: process.pid, method, params }) + "\\n");
  if (id === undefined) return;
  const result = (result) => console.log(JSON.stringify({ id, result }));
  if (method === "initialize") return result({});
  if (method === "thread/start") return result({ thread: { id: "thread-" + ++threads } });
  if (method === "mcpServerStatus/list") {
    return result(params.cursor === undefined
      ? { data: [{ name: "unrelated", tools: {} }], nextCursor: "apps" }
      : { data: [{ name: "codex_apps", tools }] });
  }
  const query = params.arguments.query;
  if (query === "timeout") return;
  if (query === "exit" && !existsSync("exited")) {
    writeFileSync("exited", "");
    process.exit(1);
  }
  if (query === "missing thread" && params.threadId === "thread-1") {
    return console.log(JSON.stringify({ id, error: { code: -32602, message: "thread not found" } }));
  }
  if (query === "refusal") {
    console.error("PRIVATE ERROR TEXT");
    return result({ isError: true, content: [{ type: "text", text: "HTTP 403: PRIVATE ERROR TEXT" }] });
  }
  if (query === "invalid") return result({ content: [{ type: "text", text: "PRIVATE ERROR TEXT" }] });
  const data = content[params.tool];
  return result(params.tool === "microsoft_teams.list_chats"
    ? { content: [{ type: "text", text: JSON.stringify(data) }] }
    : { structuredContent: data });
});
`;

interface RecordedRequest {
  readonly pid: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

let directory: string;
let gateway: AppGateway;
let reports: string[];
let hub: Hub | undefined;

function requests(method: string): RecordedRequest[] {
  return readFileSync(join(directory, "rpc.log"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as RecordedRequest)
    .filter((row) => row.method === method);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "app-gateway-"));
  appendFileSync(join(directory, "rpc.log"), "");
  reports = [];
  gateway = new AppGateway({
    cwd: directory,
    environment: process.env,
    command: scriptFile(directory, fakeAppServer),
    report: (line) => reports.push(line),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await hub?.close();
  hub = undefined;
  await gateway.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the app gateway", () => {
  it("intersects the live inventory with the exact read allowlist before forwarding a call", async () => {
    appendFileSync(join(directory, "misclassified"), "");
    await gateway.refresh();
    expect(gateway.mailboxes()).toEqual([
      { id: "outlook:outlook-a", provider: "outlook", label: "first@example.com", email: "first@example.com", link: "outlook-a" },
      { id: "outlook:outlook-b", provider: "outlook", label: "second@example.com", email: "second@example.com", link: "outlook-b" },
      { id: "gmail:connection", provider: "gmail", label: "Gmail" },
    ]);
    expect(gateway.status()).toMatchObject({ connected: true, teams: true, ticktick: true });
    expect(await gateway.call("microsoft_teams.list_chats", { top: 1 })).toMatchObject({ chats: [{ id: "chat-1" }] });
    for (const name of [
      "send_email", "gmail.send_email", "gmail.send_draft", "gmail.create_draft", "gmail.delete_emails", "gmail.forward_emails",
      "microsoft_outlook_email.send_email", "microsoft_outlook_email.reply_to_email", "microsoft_outlook_email.forward_email",
      "microsoft_outlook_email.draft_email", "microsoft_outlook_email.delete_message", "microsoft_outlook_email.mark_email_read_state",
      "microsoft_teams.send_chat_message", "microsoft_teams.reply_to_message", "microsoft_teams.send_channel_message",
      "microsoft_teams.update_message", "microsoft_teams.add_reaction", "microsoft_teams.delete_message",
      "ticktick_to_do_list_calendar.create_task", "ticktick_to_do_list_calendar.delete_task", "constructor",
    ]) {
      await expect(gateway.call(name, {})).rejects.toMatchObject({ kind: "tool not allowed" });
    }
    await expect(gateway.call("microsoft_teams.search", { query: "test" })).rejects.toMatchObject({ kind: "tool unavailable" });
    await expect(gateway.call("microsoft_outlook_email.list_messages", { link_id: "unknown" })).rejects.toMatchObject({ kind: "tool unavailable" });
    await expect(gateway.call("microsoft_outlook_email.list_attachments", { link_id: "outlook-a", content_mode: "metadata_and_payload" })).rejects.toMatchObject({ kind: "tool not allowed" });
    expect(requests("mcpServer/tool/call")).toHaveLength(1);
  });

  it("reuses its process and thread after refusal, bad data and timeout and logs only failure categories", async () => {
    await gateway.refresh();
    await expect(gateway.call("gmail.search_emails", { query: "refusal" })).rejects.toMatchObject({ kind: "tool refused", status: 403 });
    await expect(gateway.call("gmail.search_emails", { query: "invalid" })).rejects.toMatchObject({ kind: "invalid response" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rejected = expect(gateway.call("gmail.search_emails", { query: "timeout" })).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    vi.useRealTimers();
    await gateway.call("gmail.search_emails", {});
    expect(requests("process")).toHaveLength(1);
    expect(requests("thread/start")).toHaveLength(1);
    expect(requests("mcpServer/tool/call").map(({ params }) => params?.["threadId"])).toEqual(Array(4).fill("thread-1"));
    expect(reports).toContain("App gateway: tool refused (HTTP 403)");
    expect(reports).toContain("App gateway: invalid response");
    expect(reports).toContain("App gateway: timeout");
    expect(reports.join("\n")).not.toContain("PRIVATE ERROR TEXT");
  });

  it("shares one replacement thread after a concurrent thread loss and one process after a crash", async () => {
    await gateway.refresh();
    await Promise.all(Array.from({ length: 2 }, () => gateway.call("gmail.search_emails", { query: "missing thread" })));
    expect(requests("thread/start")).toHaveLength(2);
    await expect(gateway.call("gmail.search_emails", { query: "exit" })).resolves.toHaveProperty("emails");
    expect(requests("thread/start")).toHaveLength(3);
    const [first, second] = requests("process");
    expect(first?.pid).not.toBe(second?.pid);
    expect(requests("process")).toHaveLength(2);
    expect(() => process.kill(first!.pid, 0)).toThrow();
    await gateway.close();
    expect(() => process.kill(second!.pid, 0)).toThrow();
    expect(requests("turn/start")).toHaveLength(0);
    expect(requests("thread/start")[0]?.params).toMatchObject({
      ephemeral: true, sandbox: "read-only", approvalPolicy: "never", config: { "features.plugins": false },
    });
  });
});

async function listed(hub: Hub, scope?: RunningTurn): Promise<string[]> {
  const token = readFileSync(join(directory, "brain.token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${hub.address.port}${brainToolsPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(scope === undefined ? {} : { [conversationHeader]: scope.conversation, [turnHeader]: scope.turn }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const { result } = await response.json() as { result: { tools: { name: string }[] } };
  return result.tools.map(({ name }) => name);
}

it("serves paged mail, Teams chats and channels, and TickTick only to eligible brain turns", async () => {
  hub = await startTestHub({ config: testConfig(directory), appGateway: gateway });
  await gateway.refresh();
  const brain = attachBrain(hub);
  const scope = startToolTurn(brain, hub.conversations.create().id);
  expect(hub.settings.snapshot().appGateway).toEqual({
    connected: true,
    mailboxes: [
      { provider: "outlook", label: "first@example.com" },
      { provider: "outlook", label: "second@example.com" },
      { provider: "gmail", label: "Gmail" },
    ],
    teams: true,
    ticktick: true,
  });
  expect(await listed(hub, scope)).toEqual(expect.arrayContaining(["mail_mailboxes", "mail_search", "mail_read", "teams_chats", "teams_messages", "teams_search", "todo_lookup"]));
  expect(await listed(hub)).not.toContain("mail_read");
  const call = (name: string, args: Record<string, unknown>) => requestBrainTool(hub!, name, args, scope);

  const recent = await call("mail_search", { mailbox: "second@example.com" });
  expect(JSON.parse(recent.text)).toMatchObject({ untrustedAppData: { messages: [{ id: "message-1", subject: "Private mail subject" }], nextPage: 20 } });
  await call("mail_search", { mailbox: "outlook:outlook-a", query: "invoice", page: 20 });
  expect(requests("mcpServer/tool/call").map(({ params }) => params)).toMatchObject([
    { tool: "microsoft_outlook_email.list_messages", arguments: { link_id: "outlook-b", skip: 0 } },
    { tool: "microsoft_outlook_email.search_messages", arguments: { link_id: "outlook-a", query: "invoice", from_index: 20 } },
  ]);
  const first = await call("mail_read", { mailbox: "outlook:outlook-b", message_id: "message-1" });
  expect(JSON.parse(first.text)).toMatchObject({ untrustedAppData: { body: "A".repeat(8000), attachments: ["invoice.pdf"], nextOffset: 8000 } });
  const second = await call("mail_read", { mailbox: "outlook:outlook-b", message_id: "message-1", offset: 8000 });
  expect(JSON.parse(second.text)).toMatchObject({ untrustedAppData: { body: "End of private mail", nextOffset: null } });
  const gmail = await call("mail_search", { mailbox: "gmail", page: "page-1" });
  expect(JSON.parse(gmail.text)).toMatchObject({ untrustedAppData: { messages: [{ id: "gmail-1" }], nextPage: "page-2" } });
  const gmailMessage = await call("mail_read", { mailbox: "gmail:connection", message_id: "gmail-1" });
  expect(JSON.parse(gmailMessage.text)).toMatchObject({ untrustedAppData: { body: "Private Gmail body", attachments: ["private.txt"] } });
  expect(gmailMessage.text).not.toContain("Secret attachment bytes");

  expect((await call("teams_chats", {})).text).toContain("chat-1");
  expect((await call("teams_messages", { chat_id: "chat-1", since: "2026-11-21T09:00:00Z" })).text).toContain("Private Teams message");
  expect((await call("teams_chats", { view: "teams" })).text).toContain("team-1");
  expect((await call("teams_chats", { view: "channels", team_id: "team-1" })).text).toContain("channel-1");
  expect((await call("teams_messages", { team_id: "team-1", channel_id: "channel-1" })).text).toContain("channel-message-1");
  expect((await call("teams_search", { query: "test" })).text).toContain("search-hit-1");
  expect((await call("todo_lookup", {})).text).toContain("project-1");
  expect((await call("todo_lookup", { query: "test" })).text).toContain("todo-1");

  brain.receive({ type: "tool.started", ...scope, call: "private", name: "hub.mail_read", input: "Private query" });
  brain.receive({ type: "tool.output", ...scope, call: "private", delta: second.text });
  brain.receive({ type: "tool.finished", ...scope, call: "private", output: second.text, ok: true });
  expect(hub.conversations.entries(scope.conversation)).toEqual([]);
  brain.receive({ type: "provider.changed", ...scope, from: "gpt", to: "claude", model: "claude", reason: "test" });
  expect((await call("mail_mailboxes", {})).text).toContain("outlook:outlook-b");
  brain.receive({ type: "provider.changed", ...scope, from: "claude", to: "deepseek", model: "deepseek", reason: "test" });
  expect(await listed(hub, scope)).not.toContain("mail_search");
  const before = requests("mcpServer/tool/call").length;
  expect(await call("mail_read", { mailbox: "gmail", message_id: "gmail-1" })).toMatchObject({ isError: true });
  expect(requests("mcpServer/tool/call")).toHaveLength(before);
});
