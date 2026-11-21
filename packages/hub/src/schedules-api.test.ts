import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolVersion, ScheduleHistory, ScheduleList, startingEngineTable, ticketReference, type BrainInput, type HubToRunner, type Schedule, type ScheduleFields } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  title, summary: title, task: "Check and report free space.", kind: "operation", platform: "macos", engine: "codex",
  reason: { en: "A routine operation", zh: "例行操作" },
};
const standard = { difficulty: "standard", platform: "any", engine: "codex", reason: light.reason };

let dataDir: string;
let key: SigningKey;
let clock: TestClock;
let hub: Hub;

async function start() {
  const github = fakeGitHub();
  github.repositories.set(repository, [1, 2, 3].map((number) => ({ number, title: `Work ${number}`, body: "Work on the project.", state: "open", pullRequest: false })));
  hub = await startTestHub({
    config: testConfig(dataDir), keySource: staticKeySource(keySet(key)), clock, credentials: testCredentials, targets: [github],
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
  const result = await asking.call("propose_schedule", { ...plan, confirmation: "每周日凌晨三点清理 mac-mini 的空间，可以吗？", ...(target === undefined ? {} : { schedule: target }) });
  expect(result.isError, result.text).toBe(false);
  const proposal = hub.conversations.entries(topic).findLast((entry) => entry.kind === "text")?.id;
  if (proposal === undefined) throw new Error("Could not find the proposed schedule");
  expect(result.text).toContain(proposal);
  asking.finish();
  return proposal;
}

async function approve(link: BrainLink, topic: string, proposal: string): Promise<Schedule> {
  const approval = turn(link, topic, owner(topic, "好"));
  const result = await approval.call("create_schedule", { proposal });
  expect(result.isError, result.text).toBe(false);
  expect(await approval.call("create_schedule", { proposal })).toEqual(result);
  approval.finish();
  const schedule = hub.schedules.list().schedules.find((item) => result.text.includes(item.id));
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

function runner(name: string) {
  hub.machines.add({ name, accessClientId: `${name}.access` });
  const machine = hub.machines.get(name);
  if (machine === undefined) throw new Error("The work machine was not stored");
  const sent: HubToRunner[] = [];
  const link = hub.runners.attach(machine, { send: (message) => void sent.push(message), close: () => undefined });
  link.receive({ type: "hello", protocol: protocolVersion, works: [], machine: {
    hostname: name, platform: "darwin", release: "1", arch: "arm64", user: "owner", slots: { total: 2, free: 2 }, allowances: [],
    programs: [{ id: "codex", installed: true, path: "codex", version: "1", source: "program", problem: null,
      models: [{ id: startingEngineTable.codex.standard.model, efforts: [startingEngineTable.codex.standard.effort] }] }],
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

describe("scheduled work", () => {
  it("confirms once in the same topic, runs on the requested machine and delivers quietly", async () => {
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const proposal = await propose(link, topic);
    expect(hub.schedules.list().schedules).toEqual([]);
    const id = owner(topic, "好");
    expect(inputs.at(-1)?.text).toContain(proposal);
    const approval = turn(link, topic, id);
    expect((await approval.call("create_schedule", { proposal })).isError).toBe(false);
    approval.finish();
    const schedule = hub.schedules.list().schedules[0]!;
    expect(schedule).toMatchObject({ topic, machine: "mac-mini", nextAt: Date.UTC(2026, 10, 22, 8) });
    expect(hub.tickets.list()).toEqual([]);
    const other = runner("other");
    const mac = runner("mac-mini");
    const run = fire(schedule, inputs);
    expect(inputs.at(-1)).toMatchObject({ source: "hub", scheduleRun: run, text: expect.stringContaining(fields.instruction) });
    const scheduled = turn(link, topic, run);
    await openLight(scheduled);
    const ticket = hub.tickets.list()[0]!;
    expect(ticket).toMatchObject({ scheduleRun: run, light: "transfer", state: "pending", requiredMachine: "mac-mini" });
    expect(hub.chains.startScheduled(run)).toBeUndefined();
    scheduled.finish();
    expect(other.sent.filter((message) => message.type === "work.task")).toEqual([]);
    expect(mac.sent.filter((message) => message.type === "work.task")).toMatchObject([{ task: { checkout: null, light: true, ticket: ticket.id } }]);
    expect(hub.waiting.cards()).toEqual([]);
    mac.link.receive({ type: "work.event", ticket: ticket.id, attempt: 1, seq: 1, at: clock.now(),
      event: { kind: "delivered", text: "Free space checked.", files: [], report: { en: "Done", zh: "完成" } } });
    const result = hub.conversations.entries(topic).findLast((entry) => entry.kind === "delivery");
    expect(result).toMatchObject({ light: true, text: "Free space checked." });
    expect(hub.schedules.history(schedule.id)?.runs).toMatchObject([{ state: "completed", entry: result?.id }]);
  });

  it("refuses activation without a newer owner message and after expiry", async () => {
    const topic = hub.conversations.create().id;
    const { link } = brain();
    const proposal = await propose(link, topic);
    const synthetic = turn(link, topic);
    expect(await synthetic.call("create_schedule", { proposal })).toMatchObject({ isError: true, text: expect.stringContaining("newer owner message") });
    expect((await synthetic.call("run_scheduled_light_task", light)).isError).toBe(true);
    synthetic.finish();
    const other = hub.conversations.create().id;
    const wrong = turn(link, other, owner(other, "好"));
    expect((await wrong.call("create_schedule", { proposal })).isError).toBe(true);
    wrong.finish();
    clock.advance(24 * 60 * minute);
    const late = turn(link, topic, owner(topic, "好"));
    expect(await late.call("create_schedule", { proposal })).toMatchObject({ isError: true, text: expect.stringContaining("expired") });
    late.finish();
    expect(hub.schedules.list().schedules).toEqual([]);
    expect(hub.tickets.list()).toEqual([]);
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
    const schedule = await approve(link, topic, await propose(link, topic, { ...fields, repository }));
    const run = fire(schedule, inputs);
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
    const schedule = await approve(initial.link, topic, await propose(initial.link, topic, { ...fields, recurrence: { cron: "* * * * *" } }));
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

  it("requires fresh confirmation for conversation edits and invalidates a paused run before start", async () => {
    const topic = hub.conversations.create().id;
    const { link, inputs } = brain();
    const schedule = await approve(link, topic, await propose(link, topic, { ...fields, recurrence: { cron: "* * * * *" } }));
    const proposal = await propose(link, topic, { ...fields, instruction: "Check disk use.", recurrence: { cron: "* * * * *" } }, schedule.id);
    expect(hub.schedules.list().schedules[0]?.instruction).toBe(fields.instruction);
    const revised = await approve(link, topic, proposal);
    expect(revised).toMatchObject({ id: schedule.id, revision: 2, instruction: "Check disk use." });
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
