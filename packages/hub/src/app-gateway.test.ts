import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, conversationHeader, type RunningTurn, turnHeader } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppGateway, appWrites } from "./app-gateway.js";
import type { BrainLink } from "./conversations.js";
import type { Hub } from "./hub.js";
import { testConfig } from "./testing/access.js";
import { attachBrain, requestBrainTool, startToolTurn } from "./testing/brain-tools.js";
import { scriptFile } from "./testing/commands.js";
import { startTestHub } from "./testing/http.js";

const fakeAppServer = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync("rpc.log", JSON.stringify({ pid: process.pid, method: "process" }) + "\\n");
let threads = 0;
const links = [{ link_id: "outlook-a", profile_email: "first@example.com" }, { link_id: "outlook-b", profile_email: "second@example.com" }];
const writes = [
  "gmail.create_draft", "gmail.update_draft", "microsoft_outlook_email.draft_email", "microsoft_outlook_email.create_reply_draft",
  "ticktick_to_do_list_calendar.create_task", "ticktick_to_do_list_calendar.delete_task",
  "gmail.send_email", "microsoft_outlook_email.reply_to_email", "microsoft_teams.send_chat_message",
];
const names = [
  "gmail.search_emails", "gmail.read_email",
  "microsoft_outlook_email.list_messages", "microsoft_outlook_email.search_messages", "microsoft_outlook_email.fetch_message",
  "microsoft_outlook_email.list_attachments", "microsoft_teams.list_chats", "microsoft_teams.list_chat_messages",
  "microsoft_teams.list_teams", "microsoft_teams.list_channels", "microsoft_teams.list_channel_messages",
  "microsoft_teams.search", "ticktick_to_do_list_calendar.list_projects", "ticktick_to_do_list_calendar.search_task",
  ...writes,
];
const tools = () => Object.fromEntries(names.map((name) => [name, {
  name, annotations: { readOnlyHint: !writes.includes(name) && (name !== "microsoft_teams.search" || !existsSync("misclassified")) },
  inputSchema: { properties: name.startsWith("microsoft_outlook_email.") ? { link_id: { type: "string" } } : {} },
  _meta: name.startsWith("microsoft_outlook_email.") ? { link_accounts: links }
    : { link_id: name.startsWith("ticktick_to_do_list_calendar.") && existsSync("relinked") ? "new-account" : "connection" },
}]));
const mail = { id: "message-1", subject: "Private mail subject", receivedDateTime: "2026-11-21T10:00:00Z", sender: { emailAddress: { address: "sender@example.com" } } };
const content = {
  "gmail.search_emails": { emails: [{ id: "gmail-1", from_: "Gmail sender", snippet: "Private Gmail snippet", email_ts: "2026-11-21T09:00:00Z" }], next_page_token: "page-2" },
  "gmail.read_email": { email: { id: "gmail-1", payload: {
    headers: [{ name: "From", value: "Sender <sender@example.com>" }, { name: "Reply-To", value: "reply@example.com" }, { name: "Subject", value: "Private Gmail subject" }],
    parts: [{ mime_type: "text/plain", content: "Private Gmail body" }, { filename: "private.txt", content: "Secret attachment bytes" }],
  } } },
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
  "ticktick_to_do_list_calendar.list_projects": { result: [{ id: "project-1", name: "Home" }, { id: "closed-project", name: "Old", closed: true }] },
  "ticktick_to_do_list_calendar.search_task": { result: [{ id: "todo-1" }] },
  "gmail.create_draft": { draft: { id: "gmail-draft", message: { display_url: "https://mail.example.com/draft" } } },
  "gmail.update_draft": { id: "gmail-draft" },
  "microsoft_outlook_email.draft_email": { id: "outlook-draft", web_link: "https://outlook.example.com/draft" },
  "microsoft_outlook_email.create_reply_draft": { draft_message: { id: "outlook-reply" } },
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
      : { data: [{ name: "codex_apps", tools: tools() }] });
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
  if (params.tool === "ticktick_to_do_list_calendar.create_task") {
    const { task } = params.arguments;
    if (task.title === "Write then exit") process.exit(1);
    if (task.title === "Write then time out") return;
    const tasks = existsSync("tasks") ? JSON.parse(readFileSync("tasks", "utf8")) : {};
    const taskId = "task-" + (Object.keys(tasks).length + 1);
    const projectId = task.projectId ?? "inbox";
    tasks[taskId] = projectId;
    writeFileSync("tasks", JSON.stringify(tasks));
    return result({ structuredContent: { id: taskId, projectId, title: task.title } });
  }
  if (params.tool === "ticktick_to_do_list_calendar.delete_task") {
    const { task_id, project_id } = params.arguments;
    const tasks = JSON.parse(readFileSync("tasks", "utf8"));
    if (tasks[task_id] !== project_id) return result({ structuredContent: { result: { error: "Private error" } } });
    delete tasks[task_id];
    writeFileSync("tasks", JSON.stringify(tasks));
    return result({ structuredContent: { result: { deleted: task_id } } });
  }
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

function makeGateway() {
  return new AppGateway({
    cwd: directory,
    environment: process.env,
    command: scriptFile(directory, fakeAppServer),
    report: (line) => reports.push(line),
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "app-gateway-"));
  appendFileSync(join(directory, "rpc.log"), "");
  reports = [];
  gateway = makeGateway();
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

  it("refuses forbidden write names and never replays a write whose reply was lost", async () => {
    await gateway.refresh();
    for (const name of [
      "gmail.send_email", "gmail.send_draft", "gmail.forward_emails", "gmail.delete_emails",
      "microsoft_outlook_email.send_email", "microsoft_outlook_email.reply_to_email", "microsoft_outlook_email.forward_email",
      "microsoft_outlook_email.create_forward_draft", "microsoft_outlook_email.delete_message",
      "microsoft_teams.send_chat_message", "microsoft_teams.send_channel_message", "microsoft_teams.reply_to_message",
      "ticktick_to_do_list_calendar.update_task", "ticktick_to_do_list_calendar.complete_task",
    ]) {
      await expect(gateway.write(name as typeof appWrites.gmailDraft, {}, () => true)).rejects.toMatchObject({ kind: "tool not allowed" });
    }
    await expect(gateway.write(appWrites.gmailDraft, {}, () => false)).rejects.toMatchObject({ kind: "owner request required" });
    expect(requests("mcpServer/tool/call")).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timedOut = expect(gateway.write(appWrites.tickTickCreate, { task: { title: "Write then time out" } }, () => true))
      .rejects.toMatchObject({ kind: "write outcome unknown" });
    await vi.advanceTimersByTimeAsync(60_000);
    await timedOut;
    vi.useRealTimers();
    await expect(gateway.write(appWrites.tickTickCreate, { task: { title: "Write then exit" } }, () => true))
      .rejects.toMatchObject({ kind: "write outcome unknown" });
    expect(requests("mcpServer/tool/call")).toHaveLength(2);
    expect(requests("process")).toHaveLength(1);
    await expect(gateway.call("gmail.search_emails", {})).resolves.toHaveProperty("emails");
    expect(requests("process")).toHaveLength(2);
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

function ownerTurn(hub: Hub, brain: BrainLink, conversation: string, message: string): RunningTurn {
  const entry = hub.conversations.send(conversation, message);
  expect(entry).toBeDefined();
  const scope = { conversation, turn: randomUUID() };
  brain.receive({ type: "turn.started", ...scope, provider: "gpt", model: "test", inputs: [entry!.id] });
  return scope;
}

it("saves and revises drafts only in an eligible owner turn", async () => {
  hub = await startTestHub({ config: testConfig(directory), appGateway: gateway });
  await gateway.refresh();
  const brain = attachBrain(hub);
  const topic = hub.conversations.create().id;
  const background = startToolTurn(brain, topic);
  const draft = { mailbox: "second@example.com", to: ["person@example.com"], subject: "Draft subject", body: "Draft text" };
  expect(await listed(hub, background)).not.toContain("mail_draft");
  expect(await requestBrainTool(hub, "mail_draft", { ...draft, owner_requested: true }, background)).toMatchObject({ isError: true, text: expect.stringContaining("owner's request") });
  expect(requests("mcpServer/tool/call")).toHaveLength(0);
  brain.receive({ type: "turn.finished", ...background, outcome: "completed", reason: null });

  const scope = ownerTurn(hub, brain, topic, "Save a new draft and a reply in each mailbox.");
  const call = (args: Record<string, unknown>) => requestBrainTool(hub!, "mail_draft", { owner_requested: true, ...args }, scope);
  expect(await listed(hub, scope)).toContain("mail_draft");
  expect(await requestBrainTool(hub, "mail_draft", draft, scope)).toMatchObject({ isError: true });
  expect(requests("mcpServer/tool/call")).toHaveLength(0);

  const outlook = await call(draft);
  expect(JSON.parse(outlook.text)).toMatchObject({ untrustedAppData: {
    mailbox: "outlook:outlook-b", draftId: "outlook-draft", link: "https://outlook.example.com/draft",
  } });
  expect((await call({ mailbox: "first@example.com", reply_to: "outlook-message", body: "Reply" })).text).toContain("outlook-reply");
  expect((await call({ ...draft, mailbox: "gmail" })).text).toContain("gmail-draft");
  expect((await call({ mailbox: "gmail", reply_to: "gmail-1", body: "Reply" })).text).toContain("https://mail.example.com/draft");
  expect((await call({ mailbox: "gmail", draft_id: "gmail-draft", subject: "Revised subject" })).text).toContain("gmail-draft");

  expect(requests("mcpServer/tool/call").map(({ params }) => [params?.["tool"], params?.["arguments"]])).toEqual([
    [appWrites.outlookDraft, { link_id: "outlook-b", to: [{ email: "person@example.com" }], subject: "Draft subject", text_content: "Draft text", body_format: "text" }],
    [appWrites.outlookReply, { link_id: "outlook-a", message_id: "outlook-message", comment: "Reply", body_format: "text", reply_all: false }],
    [appWrites.gmailDraft, { to: "person@example.com", subject: "Draft subject", payload: { mime_type: "text/plain", body: { content: "Draft text" } } }],
    ["gmail.read_email", { message_id: "gmail-1", format: "full" }],
    [appWrites.gmailDraft, { to: "reply@example.com", subject: "Re: Private Gmail subject", reply_message_id: "gmail-1", payload: { mime_type: "text/plain", body: { content: "Reply" } } }],
    [appWrites.gmailUpdate, { draft_id: "gmail-draft", subject: "Revised subject" }],
  ]);
  brain.receive({ type: "provider.changed", ...scope, from: "gpt", to: "deepseek", model: "deepseek", reason: "test" });
  expect(await listed(hub, scope)).not.toContain("mail_draft");
  expect(await call(draft)).toMatchObject({ isError: true });
  expect(requests("mcpServer/tool/call")).toHaveLength(6);
});

it("keeps TickTick receipts across a restart and limits undo to those receipts and their connection", async () => {
  hub = await startTestHub({ config: testConfig(directory), appGateway: gateway });
  await gateway.refresh();
  let brain = attachBrain(hub);
  const topic = hub.conversations.create().id;
  let scope = ownerTurn(hub, brain, topic, "Add two TickTick tasks.");
  const call = (name: string, args: Record<string, unknown>) => requestBrainTool(hub!, name, { owner_requested: true, ...args }, scope);
  expect(await listed(hub, scope)).toEqual(expect.arrayContaining(["add_todo", "undo_created"]));
  expect(await call("add_todo", { title: "Closed list", list: "Old" })).toMatchObject({ isError: true, text: expect.stringContaining("No open TickTick list") });
  expect(await call("add_todo", { title: "Skipped hour", due: "2026-03-08T02:30" })).toMatchObject({ isError: true, text: expect.stringContaining("does not exist") });
  const first = await call("add_todo", { title: "Buy cat food", list: "home", due: "2026-11-21", notes: "Grain free" });
  const firstReceipt = JSON.parse(first.text).untrustedAppData.receipt;
  expect(JSON.parse(first.text)).toMatchObject({ untrustedAppData: { taskId: "task-1", list: "Home", due: "2026-11-21" } });
  const second = await call("add_todo", { title: "Call the bank", due: "2026-07-17T09:30", remind: true });
  const secondReceipt = JSON.parse(second.text).untrustedAppData.receipt;
  expect(requests("mcpServer/tool/call").filter(({ params }) => params?.["tool"] === appWrites.tickTickCreate).map(({ params }) => params?.["arguments"])).toEqual([
    { client_timezone: "America/New_York", task: { title: "Buy cat food", projectId: "project-1", dueDate: "2026-11-21T00:00:00.000-05:00", isAllDay: true, timeZone: "America/New_York", content: "Grain free" } },
    { client_timezone: "America/New_York", task: { title: "Call the bank", dueDate: "2026-07-17T09:30:00.000-04:00", isAllDay: false, timeZone: "America/New_York", reminders: ["TRIGGER;RELATED=END:PT0S"] } },
  ]);
  const receipts = hub.database.connection.prepare("SELECT id, topic, connection, task, project FROM ticktick_receipts ORDER BY rowid").all();
  expect(receipts).toEqual([
    { id: firstReceipt, topic, connection: "connection", task: "task-1", project: "project-1" },
    { id: secondReceipt, topic, connection: "connection", task: "task-2", project: "inbox" },
  ]);
  brain.receive({ type: "turn.finished", ...scope, outcome: "completed", reason: null });
  await hub.close();
  gateway = makeGateway();
  hub = await startTestHub({ config: testConfig(directory), appGateway: gateway });
  await gateway.refresh();
  brain = attachBrain(hub);
  scope = ownerTurn(hub, brain, topic, "Undo the task you just added.");
  expect(await call("undo_created", { receipt: "task-1" })).toMatchObject({ isError: true, text: expect.stringContaining("no matching") });
  appendFileSync(join(directory, "relinked"), "");
  await gateway.refresh();
  expect(await call("undo_created", {})).toMatchObject({ isError: true, text: expect.stringContaining("connection is unavailable") });
  rmSync(join(directory, "relinked"));
  await gateway.refresh();
  const duplicate = await Promise.all([call("undo_created", {}), call("undo_created", {})]);
  expect(duplicate.some(({ text }) => text.includes(secondReceipt))).toBe(true);
  expect(JSON.parse((await call("undo_created", {})).text)).toMatchObject({ untrustedAppData: { receipt: secondReceipt, alreadyUndone: true } });
  expect(JSON.parse(readFileSync(join(directory, "tasks"), "utf8"))).toEqual({ "task-1": "project-1" });
  expect(requests("mcpServer/tool/call").filter(({ params }) => params?.["tool"] === appWrites.tickTickDelete).map(({ params }) => params?.["arguments"])).toEqual([
    { project_id: "inbox", task_id: "task-2" },
  ]);
});
