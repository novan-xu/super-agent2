import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolVersion, ScheduleHistory, ScheduleList, SchedulesUpdate, startingEngineTable, ticketReference, type BrainInput, type HubToRunner, type Schedule, type ScheduleFields } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { BrainLink } from "./conversations.js";
import type { Hub } from "./hub.js";
import { assertion, keySet, signingKey, staticKeySource, TestClock, testConfig, type SigningKey } from "./testing/access.js";
import { requestBrainTool } from "./testing/brain-tools.js";
import { testCredentials } from "./testing/commands.js";
import { fakeGitHub } from "./testing/github.js";
import { startTestHub } from "./testing/http.js";

const minute = 60_000;
const repository = "owner/project";
const requested = "每周日凌晨三点清理一下 mac-mini 的空间";
const title = { en: "Check free space", zh: "检查剩余空间" };
const fields = {
  title: "清理 Mac 空间", instruction: "Check free space on mac-mini and clean up approved temporary files.",
  recurrence: { cron: "0 3 * * 0" }, machine: "mac-mini",
} satisfies ScheduleFields;
const light = {
  title, summary: title, task: "Check and report free space.", kind: "operation", platform: "macos",
  reason: { en: "A routine operation", zh: "例行操作" },
};
const standard = { difficulty: "standard", platform: "any", reason: light.reason };
const loomToken = "L".repeat(64);
const triggerFields = { ...fields, title: "整理 Loom", instruction: "Organize the due Loom material.", recurrence: { trigger: "loom" } } satisfies ScheduleFields;
const loomRequest = { kind: "organize", text: "The daily organizing is due.", link: "https://loom.example/due" };

let dataDir: string;
let key: SigningKey;
let clock: TestClock;
let hub: Hub;

async function start() {
  const github = fakeGitHub();
  github.repositories.set(repository, [1, 2, 3].map((number) => ({ number, title: `Work ${number}`, body: "Work on the project.", state: "open", pullRequest: false })));
  hub = await startTestHub({
    config: { ...testConfig(dataDir), workRequests: { port: 0, directory: dataDir } },
    keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials, targets: [github],
    scheduleTicker: () => () => undefined,
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-schedules-"));
  key = await signingKey("schedule-key");
  clock = new TestClock();
  await start();
});

afterEach(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function brain() {
  const inputs: BrainInput[] = [];
  const link = hub.conversations.attach({ send: (message) => { if (message.type === "input") inputs.push(message.input); }, close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, running: [] });
  return { link, inputs };
}

function turn(link: BrainLink, conversation: string, ...inputs: string[]) {
  const scope = { conversation, turn: randomUUID() };
  link.receive({ type: "turn.started", ...scope, provider: "gpt", model: "test", inputs });
  return {
    call: (name: string, args: Record<string, unknown>) => requestBrainTool(hub, name, args, scope),
    reply: (words: string) => link.receive({ type: "text", ...scope, block: "answer", delta: words }),
    finish: () => {
      link.receive({ type: "turn.finished", ...scope, outcome: "completed", reason: null });
      hub.schedules.tick();
    },
  };
}

function owner(topic: string, words: string): string {
  const entry = hub.conversations.send(topic, words);
  if (entry === undefined) throw new Error("Could not store the owner's message");
  return entry.id;
}

async function propose(link: BrainLink, topic: string, plan: ScheduleFields = fields, target?: string): Promise<string> {
  const asking = turn(link, topic, owner(topic, requested));
  const result = await asking.call("propose_schedule", { ...plan, ...(target === undefined ? {} : { schedule: target }) });
  expect(result.isError, result.text).toBe(false);
  const proposal = /Schedule proposal ([a-f0-9-]+)/.exec(result.text)?.[1];
  if (proposal === undefined) throw new Error(result.text);
  expect(result.text).toContain(`[定时](/schedules?proposal=${proposal})`);
  asking.finish();
  return proposal;
}

async function approve(proposal: string, edited?: ScheduleFields): Promise<Schedule> {
  const pending = hub.schedules.list().proposals.find(({ id }) => id === proposal);
  if (pending === undefined) throw new Error("The proposal is missing");
  const response = await request(`/proposals/${proposal}/confirm`, "POST", edited === undefined ? {} : { fields: edited });
  expect(response.status).toBe(200);
  const activated = ScheduleList.parse(await response.json());
  expect(activated.proposals.some(({ id }) => id === proposal)).toBe(false);
  const schedule = pending.target === null ? activated.schedules[0] : activated.schedules.find(({ id }) => id === pending.target);
  if (schedule === undefined) throw new Error("The schedule was not activated");
  return schedule;
}

function fire(schedule: Schedule, inputs: readonly BrainInput[]): string {
  if (schedule.nextAt === null) throw new Error("The schedule is not due to run");
  clock.advance(schedule.nextAt - clock.now());
  hub.schedules.tick();
  const input = inputs.findLast((item) => item.scheduleRun !== undefined);
  if (input === undefined || input.scheduleRun !== input.id) throw new Error("The scheduled input did not arrive");
  return input.id;
}

async function openLight(scheduled: ReturnType<typeof turn>) {
  const result = await scheduled.call("run_scheduled_light_task", light);
  expect(result.isError, result.text).toBe(false);
}

function runner(name: string, engines: readonly ("codex" | "claude" | "dsh")[] = ["codex", "dsh"]) {
  hub.machines.add({ name, accessClientId: `${name}.access` });
  const machine = hub.machines.get(name);
  if (machine === undefined) throw new Error("The work machine was not stored");
  const sent: HubToRunner[] = [];
  const link = hub.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, works: [], machine: {
    hostname: name, platform: "darwin", release: "1", arch: "arm64", user: "owner", slots: { total: 2, free: 2 }, allowances: [],
    programs: engines.map((id) => ({
      id, installed: true, path: id, version: "1", source: "program" as const, problem: null,
      models: [{ id: startingEngineTable[id].standard.model, efforts: [startingEngineTable[id].standard.effort] }],
    })),
  } });
  return { link, sent };
}

async function request(path: string, method = "GET", body?: unknown, trusted = true): Promise<Response> {
  const base = `http://127.0.0.1:${hub.address.port}`;
  return fetch(`${base}/api/schedules${path}`, {
    method, headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }), ...(body === undefined ? {} : {
      "content-type": "application/json", origin: trusted ? base : "https://untrusted.example",
    }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function registerSource(source = "loom", token = loomToken): void {
  writeFileSync(join(dataDir, `${source}.sha256`), `${createHash("sha256").update(token).digest("hex")}\n`);
}

function workRequest(idempotencyKey: string, { source = "loom", token = loomToken, body = loomRequest, port = hub.workRequestAddress?.port }: {
  source?: string; token?: string; body?: { kind: string; text: string; link?: string }; port?: number;
} = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/work-requests/${source}`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey,
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body),
  });
}

describe("scheduled work", () => {
  it("lets an authorized scheduled turn queue a topic merge and refuses it after a pause", async () => {
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const schedule = await approve(await propose(link, topic, { ...fields, recurrence: { cron: "* * * * *" } }));
    const scheduled = turn(link, topic, fire(schedule, inputs));
    const source = hub.conversations.create().id;
    const destination = hub.conversations.create().id;
    const accepted = await scheduled.call("merge_topics", { destination, sources: [source] });
    expect(accepted.isError).toBe(false);
    expect(JSON.parse(accepted.text)).toEqual([{ topic: source, result: "merge queued" }]);
    expect(hub.conversations.get(source)?.mergePending).toBe(true);

    expect((await request(`/${schedule.id}/pause`, "POST", {})).status).toBe(200);
    const refused = await scheduled.call("merge_topics", { destination: hub.conversations.create().id, sources: [hub.conversations.create().id] });
    expect(refused).toMatchObject({ isError: true, text: "This scheduled run is no longer authorized." });
    scheduled.finish();
  });

  it("confirms once on the schedules page, runs on the requested machine and delivers quietly", async () => {
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const proposal = await propose(link, topic);
    expect(hub.schedules.list().schedules).toEqual([]);
    const pending = ScheduleList.parse(await (await request("")).json()).proposals;
    expect(pending).toEqual([{ id: proposal, topic, topicRepository: null, fields, target: null, targetRevision: null, createdAt: clock.now() }]);
    expect(hub.conversations.entries(topic).map(({ kind }) => kind)).toEqual(["owner"]);
    const schedule = await approve(proposal);
    expect(hub.conversations.entries(topic).at(-1)).toMatchObject({ kind: "notice", text: "定时任务「清理 Mac 空间」已确认。" });
    expect((await request(`/proposals/${proposal}/confirm`, "POST", {})).status).toBe(404);
    expect(hub.schedules.list().schedules).toHaveLength(1);
    expect(schedule).toMatchObject({ topic, machine: "mac-mini", nextAt: Date.UTC(2026, 10, 22, 8) });
    expect(hub.tickets.list()).toEqual([]);
    const other = runner("other");
    const mac = runner("mac-mini", ["codex", "claude", "dsh"]);
    hub.settings.setOrder("worker", ["deepseek", "gpt", "claude"]);
    const run = fire(schedule, inputs);
    expect(inputs.at(-1)).toMatchObject({ source: "hub", scheduleRun: run, text: expect.stringContaining(fields.instruction) });
    const scheduled = turn(link, topic, run);
    expect(await scheduled.call("run_scheduled_light_task", { ...light, machine: "other" })).toMatchObject({
      isError: true, text: expect.stringContaining("requires machine mac-mini"),
    });
    const resultWithProject = await scheduled.call("run_scheduled_light_task", { ...light, project: repository, machine: "mac-mini", ownerEngine: "claude" });
    expect(resultWithProject.isError, resultWithProject.text).toBe(false);
    expect(hub.conversations.get(topic)?.repository).toBeNull();
    const ticket = hub.tickets.list()[0]!;
    expect(ticket).toMatchObject({ scheduleRun: run, light: "transfer", project: repository, state: "pending", requiredMachine: "mac-mini", enginePin: "claude" });
    expect(hub.chains.startScheduled(run)).toBeUndefined();
    scheduled.finish();
    expect(other.sent.filter((message) => message.type === "work.task")).toEqual([]);
    expect(mac.sent.filter((message) => message.type === "work.task")).toMatchObject([{ task: { checkout: null, light: true, ticket: ticket.id, engine: "claude" } }]);
    expect(hub.waiting.cards()).toEqual([]);
    mac.link.receive({ type: "work.event", ticket: ticket.id, attempt: 1, seq: 1, at: clock.now(),
      event: { kind: "delivered", text: "Free space checked.", files: [], report: { en: "Done", zh: "完成" } } });
    const result = hub.conversations.entries(topic).findLast((entry) => entry.kind === "delivery");
    expect(result).toMatchObject({ light: true, text: "Free space checked." });
    expect(hub.schedules.history(schedule.id)?.runs).toMatchObject([{ state: "completed", entry: result?.id }]);
  });

  it("keeps pending cards across a restart and removes a discarded proposal without activating it", async () => {
    const topic = hub.conversations.create().id;
    const { link } = brain();
    const proposal = await propose(link, topic);
    const independent = await propose(link, topic, { ...fields, title: "检查备份" });
    await hub.close();
    clock.advance(24 * 60 * minute);
    await start();

    expect(hub.schedules.list().proposals.map(({ id }) => id)).toEqual([independent, proposal]);
    const discardPath = `/proposals/${proposal}/discard`;
    const confirmPath = `/proposals/${proposal}/confirm`;
    const base = `http://127.0.0.1:${hub.address.port}`;
    expect((await fetch(base + "/api/schedules" + confirmPath, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" })).status).toBe(403);
    expect((await request(confirmPath, "POST", {}, false)).status).toBe(403);
    expect((await request(discardPath, "POST", {}, false)).status).toBe(403);
    expect((await request(discardPath, "POST", {})).status).toBe(200);
    expect((await request(confirmPath, "POST", {})).status).toBe(404);
    expect(hub.schedules.list()).toMatchObject({ schedules: [], proposals: [{ id: independent }] });
    await approve(independent);
    expect(hub.schedules.list().proposals).toEqual([]);
  });

  it("pushes the global pending count to the owner socket", async () => {
    const base = `ws://127.0.0.1:${hub.address.port}`;
    const socket = new WebSocket(base + "/ws", { headers: { "Cf-Access-Jwt-Assertion": await assertion({ key, clock }) } });
    const counts: number[] = [];
    socket.on("message", (data) => {
      const update = SchedulesUpdate.safeParse(JSON.parse(String(data)));
      if (update.success) counts.push(update.data.pending);
    });
    try {
      await vi.waitFor(() => expect(counts).toEqual([0]));
      const proposal = await propose(brain().link, hub.conversations.create().id);
      await vi.waitFor(() => expect(counts).toEqual([0, 1]));
      expect((await request(`/proposals/${proposal}/discard`, "POST", {})).status).toBe(200);
      await vi.waitFor(() => expect(counts).toEqual([0, 1, 0]));
    } finally {
      socket.close();
    }
  });

  it.each(["pause", "delete"] as const)("refuses an edit proposal after the target receives %s", async (action) => {
    const topic = hub.conversations.create().id;
    const { link } = brain();
    const target = await approve(await propose(link, topic));
    const superseded = await propose(link, topic, { ...fields, title: "检查硬盘" }, target.id);
    const source = hub.conversations.create().id;
    const proposal = await propose(link, source, { ...fields, title: "检查主机" }, target.id);
    expect(hub.schedules.list().proposals).toMatchObject([{ id: proposal, topic: source, target: target.id, targetRevision: 1 }]);
    expect((await request(`/proposals/${superseded}/confirm`, "POST", {})).status).toBe(404);
    expect((await request(`/${target.id}/${action}`, "POST", {})).status).toBe(200);
    const refused = await request(`/proposals/${proposal}/confirm`, "POST", {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "conflict", reason: "The schedule changed or was deleted. Read it again." });
    expect(hub.schedules.list().proposals).toMatchObject([{ id: proposal }]);
    expect(hub.schedules.list().schedules.some(({ title }) => title === "检查主机")).toBe(false);
  });

  it("starts the arranged code chain and its task without starting an unrelated pending ticket", async () => {
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const ordinary = turn(link, topic, owner(topic, "准备另外一个工单"));
    const issueArgs = { repository, title_zh: "更新依赖", summary: title, kind: "maintenance" };
    expect((await ordinary.call("open_ticket", { ...issueArgs, issue: 3 })).isError).toBe(false);
    const other = hub.tickets.list()[0]!;
    expect((await ordinary.call("choose_defaults", { chains: [{ ...standard, ticket: ticketReference(other), kind: "maintenance", issues: [{ number: 3, difficulty: "standard" }] }] })).isError).toBe(false);
    ordinary.finish();
    const mac = runner("mac-mini");
    const schedule = await approve(await propose(link, topic, { ...fields, repository }));
    const run = fire(schedule, inputs);
    expect(inputs.at(-1)?.text).toContain("State defaults for every visible ticket this run opens.");
    expect(inputs.at(-1)?.text).toContain("Arrange only work opened by this run");
    const scheduled = turn(link, topic, run);
    for (const issue of [1, 2]) expect((await scheduled.call("open_ticket", { ...issueArgs, issue })).isError).toBe(false);
    expect((await scheduled.call("read_ticket", { ticket: ticketReference(other) })).isError).toBe(false);
    const spec = { name: "dependencies", repository, title, summary: title };
    expect((await scheduled.call("arrange_chains", { chains: [{ ...spec, issues: [3] }] })).isError).toBe(true);
    const arranged = await scheduled.call("arrange_chains", { chains: [{ ...spec, issues: [1, 2] }] });
    expect(arranged.isError, arranged.text).toBe(false);
    const chain = hub.tickets.list().find((ticket) => ticket.issues.length === 2)!;
    expect(chain.scheduleRun).toBe(run);
    const task = await scheduled.call("open_task_ticket", { title, summary: title, kind: "operation", task: "Check service health.", project: repository, after: [ticketReference(chain)] });
    expect(task.isError, task.text).toBe(false);
    const visible = hub.tickets.list().find((ticket) => ticket.form === "task")!;
    const chosen = await scheduled.call("choose_defaults", { chains: [
      { ...standard, ticket: ticketReference(chain), kind: "maintenance", issues: [1, 2].map((number) => ({ number, difficulty: "standard" })) },
      { ...standard, ticket: ticketReference(visible), kind: "operation" },
    ] });
    expect(chosen.isError, chosen.text).toBe(false);
    expect(other.scheduleRun).toBeUndefined();
    expect(hub.chains.cards().map((card) => card.ticket.id)).toEqual([other.id]);
    expect(hub.chains.startScheduled(randomUUID())).toBeUndefined();
    scheduled.reply("已安排更新和服务检查。");
    scheduled.finish();
    await hub.chains.idle();
    expect(hub.tickets.get(chain.id)).toMatchObject({ state: "working", machine: "mac-mini" });
    expect(hub.tickets.get(visible.id)).toMatchObject({ state: "waiting", scheduleRun: run });
    expect(hub.tickets.get(other.id)?.state).toBe("pending");
    expect(mac.sent).toContainEqual(expect.objectContaining({ type: "work.start", task: expect.objectContaining({ ticket: chain.id }) }));
  });

  it("collapses missed slots across a restart and skips while any prior run has active work", async () => {
    const topic = hub.conversations.create().id;
    const initial = brain();
    const schedule = await approve(await propose(initial.link, topic, { ...fields, recurrence: { cron: "* * * * *" } }));
    await hub.close();
    clock.advance(12 * minute);
    await start();
    hub.schedules.tick();
    expect(hub.schedules.history(schedule.id)?.runs).toEqual([]);
    const { link, inputs } = brain();
    hub.schedules.tick();
    hub.schedules.tick();
    const run = inputs.find((item) => item.scheduleRun !== undefined)?.id;
    if (run === undefined) throw new Error("The missed schedule did not run");
    expect(inputs.filter((item) => item.scheduleRun !== undefined)).toHaveLength(1);
    const scheduled = turn(link, topic, run);
    await openLight(scheduled);
    scheduled.finish();
    expect(hub.tickets.list()).toMatchObject([{ state: "waiting", scheduleRun: run }]);
    clock.advance(minute);
    hub.schedules.tick();
    clock.advance(minute);
    hub.schedules.tick();
    expect(hub.schedules.history(schedule.id)?.runs.map((item) => item.state)).toEqual(["skipped", "skipped", "running"]);
    expect(hub.conversations.entries(topic).at(-1)).toMatchObject({ text: expect.stringContaining("已跳过") });
  });

  it("applies owner-edited proposals as a new revision and invalidates a paused run before start", async () => {
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const schedule = await approve(await propose(link, topic, { ...fields, recurrence: { cron: "* * * * *" } }));
    const source = hub.conversations.create().id;
    const plan = { ...fields, instruction: "Check disk use.", recurrence: { cron: "* * * * *" } };
    const proposal = await propose(link, source, plan, schedule.id);
    expect(hub.schedules.list().schedules[0]?.instruction).toBe(fields.instruction);
    const edited = { ...plan, instruction: "Check disk use and report remaining space." };
    const revised = await approve(proposal, edited);
    expect(revised).toMatchObject({ id: schedule.id, topic, revision: 2, instruction: edited.instruction });
    expect(hub.conversations.entries(topic).at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("变更已确认") });
    const run = fire(revised, inputs);
    const scheduled = turn(link, topic, run);
    await openLight(scheduled);
    expect((await scheduled.call("pause_schedule", { schedule: revised.id })).isError).toBe(true);
    expect((await request(`/${revised.id}/pause`, "POST", {})).status).toBe(200);
    scheduled.finish();
    expect(hub.chains.startScheduled(run)).toBeUndefined();
    expect(hub.tickets.list()).toMatchObject([{ state: "stopped" }]);
    expect(hub.schedules.history(revised.id)?.runs).toMatchObject([{ state: "cancelled" }]);
  });

  it.each(["completed", "interrupted"] as const)("continues the same scheduled run until the retry is %s", async (outcome) => {
    const first = brain();
    const id = hub.schedules.save({ ...fields, recurrence: { at: clock.now() + minute } });
    const schedule = hub.schedules.list().schedules[0]!;
    const run = fire(schedule, first.inputs);
    const scheduled = turn(first.link, schedule.topic, run);
    await openLight(scheduled);
    const [task] = hub.tickets.list();
    expect(task).toMatchObject({ scheduleRun: run, state: "pending" });

    const second = brain();
    expect(second.inputs).toMatchObject([{ source: "hub", scheduleRun: run, text: expect.stringContaining(fields.instruction) }]);
    const continuation = second.inputs[0]!;
    expect(continuation.id).not.toBe(run);
    hub.schedules.tick();
    expect(hub.schedules.history(id)?.runs).toMatchObject([{ id: run, state: "queued", entry: run }]);
    expect(hub.tickets.get(task!.id)?.state).toBe("pending");
    expect(await scheduled.call("run_command", {})).toMatchObject({ isError: true, text: "This scheduled run is no longer authorized." });

    const retry = turn(second.link, schedule.topic, continuation.id);
    expect(hub.schedules.history(id)?.runs).toMatchObject([{ id: run, state: "running" }]);
    if (outcome === "completed") {
      retry.reply("已安排检查磁盘空间。");
      retry.finish();
      expect(hub.schedules.history(id)?.runs).toMatchObject([{ id: run, state: "running", tickets: [{ id: task!.id, state: "waiting" }] }]);
    } else {
      expect(brain().inputs).toEqual([]);
      hub.schedules.tick();
      expect(hub.schedules.history(id)?.runs).toMatchObject([{ id: run, state: "interrupted", tickets: [{ id: task!.id, state: "stopped" }] }]);
    }
  });

  it("lets the same-origin owner create, edit, pause, resume and delete from the API", async () => {
    const plan = { ...fields, recurrence: { at: clock.now() + 2 * minute } };
    expect((await request("", "POST", { fields: plan }, false)).status).toBe(403);
    expect((await request("", "POST", { fields: { ...plan, recurrence: { cron: "90 * * * *" } } })).status).toBe(422);
    const created = ScheduleList.parse(await (await request("", "POST", { fields: plan })).json()).schedules[0]!;
    expect(created).toMatchObject({ state: "active", nextAt: plan.recurrence.at });
    expect((await request(`/${created.id}`, "PUT", { fields: { ...plan, title: "重新检查空间" }, revision: created.revision })).status).toBe(200);
    expect((await request(`/${created.id}`, "PUT", { fields: plan, revision: created.revision })).status).toBe(422);
    expect((await request(`/${created.id}/pause`, "POST", {})).status).toBe(200);
    const { link, inputs } = brain();
    clock.advance(3 * minute);
    hub.schedules.tick();
    expect(inputs).toEqual([]);
    const resumed = ScheduleList.parse(await (await request(`/${created.id}/resume`, "POST", {})).json()).schedules[0]!;
    hub.schedules.tick();
    const run = inputs.at(-1)?.scheduleRun;
    if (run === undefined) throw new Error("The resumed schedule did not run");
    const scheduled = turn(link, resumed.topic, run);
    scheduled.reply("空间充足。");
    scheduled.finish();
    const history = ScheduleHistory.parse(await (await request(`/${created.id}`)).json());
    expect(history.runs).toMatchObject([{ state: "completed" }]);
    expect(history.runs[0]?.entry).not.toBe(run);
    expect(hub.schedules.list().schedules[0]).toMatchObject({ state: "completed", nextAt: null });
    clock.advance(10 * minute);
    hub.schedules.tick();
    expect(inputs.filter((item) => item.scheduleRun !== undefined)).toHaveLength(1);
    expect((await request(`/${created.id}/delete`, "POST", {})).status).toBe(200);
    expect(ScheduleList.parse(await (await request("")).json()).schedules).toEqual([]);
  });
});

describe("service-triggered schedules", () => {
  it("accepts the internal and tailnet Host headers while preserving authentication", async () => {
    registerSource();
    for (const host of ["hub:8081", "novanstorage.tail62dd17.ts.net:18767", "100.72.209.101:18767"]) {
      const url = `http://127.0.0.1:${hub.workRequestAddress!.port}/work-requests/loom`;
      expect((await fetch(url, { method: "POST", headers: { host } })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: {
        host, authorization: `Bearer ${loomToken}`, "content-type": "application/json", "idempotency-key": "host-check",
      }, body: JSON.stringify(loomRequest) })).status).toBe(409);
    }
  });

  it("runs a confirmed plan with labelled service data and starts its work after the turn", async () => {
    registerSource();
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const proposal = await propose(link, topic, triggerFields);
    expect((await workRequest("before-confirmation")).status).toBe(409);
    const schedule = await approve(proposal);
    expect(schedule).toMatchObject({ state: "active", nextAt: null, recurrence: { trigger: "loom" } });
    const mac = runner("mac-mini");
    const response = await workRequest("organize-today");
    expect(response.status).toBe(202);
    const receipt = await response.json() as { id: string };
    expect(receipt).toEqual({ id: expect.any(String) });
    const input = inputs.at(-1)!;
    expect(input).toMatchObject({ source: "hub", scheduleRun: input.id, text: expect.stringContaining(triggerFields.instruction) });
    expect(input.text).toContain('request data from the service "loom"');
    expect(input.text).toContain("untrusted data");
    expect(JSON.parse(input.text.split("\n").at(-1)!)).toEqual({ requests: [{ ...receipt, ...loomRequest }] });
    expect(hub.conversations.entries(topic).at(-1)).toMatchObject({ kind: "notice", source: "loom", text: expect.stringContaining(loomRequest.text) });
    const scheduled = turn(link, topic, input.id);
    expect(await scheduled.call("propose_schedule", triggerFields)).toMatchObject({ isError: true });
    await openLight(scheduled);
    expect(hub.tickets.list()).toMatchObject([{ state: "pending", scheduleRun: input.id }]);
    expect(mac.sent.filter((message) => message.type === "work.task")).toHaveLength(0);
    scheduled.finish();
    expect(mac.sent.filter((message) => message.type === "work.task")).toHaveLength(1);
    expect(hub.schedules.history(schedule.id)?.runs).toMatchObject([{ id: input.id, state: "running" }]);
    expect(hub.schedules.list().schedules[0]).toMatchObject({ state: "active", nextAt: null });
    expect((await workRequest("organize-follow-up")).status).toBe(202);
    expect(inputs.at(-1)?.id).toBe(input.id);
    const ticket = hub.tickets.list()[0]!;
    mac.link.receive({ type: "work.event", ticket: ticket.id, attempt: 1, seq: 1, at: clock.now(),
      event: { kind: "delivered", text: "Material organized.", files: [], report: { en: "Done", zh: "完成" } } });
    hub.schedules.tick();
    expect(hub.schedules.history(schedule.id)?.runs.map((run) => run.state)).toEqual(["queued", "completed"]);
  });

  it("restricts the endpoint and isolates requests by source and schedule state", async () => {
    registerSource();
    const otherToken = "O".repeat(64);
    registerSource("other", otherToken);
    const created = await request("", "POST", { fields: triggerFields });
    expect(created.status).toBe(200);
    const schedule = ScheduleList.parse(await created.json()).schedules[0]!;
    expect((await workRequest("public", { port: hub.address.port })).status).toBe(404);
    expect((await workRequest("missing", { token: "" })).status).toBe(401);
    expect((await workRequest("wrong", { token: otherToken })).status).toBe(401);
    expect((await workRequest("unknown", { source: "unknown" })).status).toBe(401);
    expect((await workRequest("another", { source: "other", token: otherToken })).status).toBe(409);
    expect((await workRequest("")).status).toBe(400);
    expect((await workRequest("invalid", { body: { ...loomRequest, text: " " } })).status).toBe(400);
    expect((await workRequest("before-pause")).status).toBe(202);
    expect((await request(`/${schedule.id}/pause`, "POST", {})).status).toBe(200);
    expect(hub.schedules.list().schedules[0]).toMatchObject({ state: "paused", nextAt: null });
    expect((await workRequest("while-paused")).status).toBe(409);
    expect((await request(`/${schedule.id}/resume`, "POST", {})).status).toBe(200);
    expect(hub.schedules.list().schedules[0]).toMatchObject({ state: "active", nextAt: null });
    const { inputs } = brain();
    hub.schedules.tick();
    expect(inputs).toEqual([]);
    expect((await request(`/${schedule.id}/delete`, "POST", {})).status).toBe(200);
    expect((await workRequest("after-delete")).status).toBe(409);
    const rotated = "R".repeat(64);
    registerSource("loom", rotated);
    expect((await workRequest("rotated-out")).status).toBe(401);
    expect((await workRequest("rotated-in", { token: rotated })).status).toBe(409);
  });

  it("fans out and keeps one follow-up batch per schedule across a queued or running turn", async () => {
    registerSource();
    const first = hub.schedules.save(triggerFields);
    const second = hub.schedules.save({ ...triggerFields, title: "更新 Loom 主题" });
    hub.schedules.save({ ...triggerFields, recurrence: { trigger: "other" } });
    const { link, inputs } = brain();
    const initial = await workRequest("initial");
    expect(initial.status).toBe(202);
    const receipt = await initial.json();
    expect(inputs).toHaveLength(2);
    const schedules = [first, second].map((id) => hub.schedules.list().schedules.find((schedule) => schedule.id === id)!);
    const runs = schedules.map((schedule) => schedule.lastRun!.id);
    const active = turn(link, schedules[0]!.topic, runs[0]!);
    const duplicate = await workRequest("initial");
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(receipt);
    expect((await workRequest("initial", { body: { ...loomRequest, text: "Different request with the same key" } })).status).toBe(409);
    for (let index = 0; index < 10; index++) {
      expect((await workRequest(`burst-${index}`, { body: { kind: "topic", text: `Topic ${index}` } })).status).toBe(202);
    }
    expect(inputs).toHaveLength(2);
    expect(hub.schedules.history(first)?.runs).toMatchObject([{ state: "running" }]);
    expect(hub.schedules.history(second)?.runs).toMatchObject([{ state: "queued" }]);
    active.finish();
    turn(link, schedules[1]!.topic, runs[1]!).finish();
    expect(inputs).toHaveLength(4);
    for (const input of inputs.slice(2)) {
      expect(JSON.parse(input.text.split("\n").at(-1)!)).toMatchObject({
        requests: Array.from({ length: 10 }, (_, index) => ({ kind: "topic", text: `Topic ${index}` })),
      });
    }
    expect((await workRequest("initial")).status).toBe(202);
    hub.schedules.tick();
    expect(inputs).toHaveLength(4);
  });

  it("persists pending requests and idempotency across a hub restart and limits each source", async () => {
    registerSource();
    registerSource("other", "O".repeat(64));
    const schedule = hub.schedules.save(triggerFields);
    hub.schedules.save({ ...triggerFields, recurrence: { trigger: "other" } });
    const original = await workRequest("original");
    expect(original.status).toBe(202);
    const receipt = await original.json();
    for (let index = 1; index < 60; index++) expect((await workRequest(`rate-${index}`)).status).toBe(202);
    expect((await workRequest("limited")).status).toBe(429);
    expect((await workRequest("original", { source: "other", token: "O".repeat(64) })).status).toBe(202);
    expect(hub.schedules.history(schedule)?.runs).toEqual([]);
    await hub.close();
    await start();
    expect(await (await workRequest("limited")).json()).toEqual({ error: "rate_limited" });
    clock.advance(minute);
    const full = await workRequest("limited");
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({ error: "queue_full" });
    const { inputs } = brain();
    const duplicate = await workRequest("original");
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(receipt);
    expect(inputs).toHaveLength(2);
    expect((await workRequest("limited")).status).toBe(202);
    expect(inputs).toHaveLength(2);
  });
});
