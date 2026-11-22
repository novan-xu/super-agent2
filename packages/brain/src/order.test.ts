import type { BrainMessage, Provider } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { createBrain } from "./brain.js";
import { FakeProgram } from "./testing/fake.js";

class FixedClock {
  constructor(public current = 1_000_000) {}

  now(): number {
    return this.current;
  }
}

function setup(order: Provider[]) {
  const sent: BrainMessage[] = [];
  const programs = { gpt: new FakeProgram("gpt"), claude: new FakeProgram("claude"), deepseek: new FakeProgram("deepseek") };
  const clock = new FixedClock();
  const brain = createBrain({
    adapters: new Map<Provider, FakeProgram>(Object.entries(programs) as [Provider, FakeProgram][]),
    order,
    clock,
    transport: {
      send: (message) => sent.push(message),
      prepare: (call) => Promise.resolve({ type: "prepared", request: call.conversation, session: null, history: [], memory: null }),
    },
    tools: { url: "http://hub/brain/mcp", token: "t" },
    workspace: "/tmp/workspace",
    newId: (() => {
      let count = 0;
      return () => `turn-${(count += 1)}`;
    })(),
  });
  return { brain, sent, programs, clock };
}

function startedWith(sent: readonly BrainMessage[]): Provider[] {
  return sent.flatMap((message) => (message.type === "turn.started" ? [message.provider] : []));
}

it.each([["gpt", "hub.mail_read"], ["claude", "mcp__hub__mail_read"]] as const)(
  "keeps private %s app tool events off the hub link",
  async (provider, name) => {
    const { brain, sent, programs } = setup([provider]);
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "Read my mail", attachments: [] } });
    const { handle } = await programs[provider].next();
    handle.emit({ type: "tool.started", call: "mail", name, input: "Private mailbox" });
    handle.emit({ type: "tool.output", call: "mail", delta: "Private output" });
    handle.emit({ type: "tool.finished", call: "mail", output: "Private message", ok: true });
    handle.emit({ type: "tool.started", call: "regular", name: "hub.read_ticket", input: "#" });
    expect(sent.filter((event) => event.type.startsWith("tool."))).toEqual([
      expect.objectContaining({ type: "tool.started", name: "hub.read_ticket" }),
    ]);
    handle.finish();
    await brain.close();
  },
);

describe("the brain's provider order", () => {
  it("is changed by the hub and applies to the next message", async () => {
    const { brain, sent, programs } = setup(["gpt", "claude", "deepseek"]);
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "hello", attachments: [] } });
    (await programs.gpt.next()).handle.finish("hi");
    await brain.settled();
    brain.receive({ type: "order", order: ["deepseek", "claude", "gpt"] });
    expect(sent.at(-1)).toMatchObject({ type: "providers", order: ["deepseek", "claude", "gpt"] });
    brain.receive({ type: "input", conversation: "c1", input: { id: "i2", source: "owner", text: "again", attachments: [] } });
    (await programs.deepseek.next()).handle.finish("hi");
    await brain.settled();
    expect(startedWith(sent)).toEqual(["gpt", "deepseek"]);
    await brain.close();
  });

  it("tells the hub each provider's state when it changes, and keeps only providers it has a program for", async () => {
    const { brain, sent, programs, clock } = setup(["gpt", "claude", "deepseek"]);
    expect(brain.status()).toEqual({
      type: "providers",
      order: ["gpt", "claude", "deepseek"],
      model: "gpt-model",
      providers: [
        { provider: "gpt", model: "gpt-model", effort: "high", available: true, until: null },
        { provider: "claude", model: "claude-model", effort: "high", available: true, until: null },
        { provider: "deepseek", model: "deepseek-model", effort: "high", available: true, until: null },
      ],
    });
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "hello", attachments: [] } });
    (await programs.gpt.next()).handle.emit({ type: "unavailable", reason: "usage limit", until: clock.now() + 60_000 });
    (await programs.claude.next()).handle.finish("hi");
    await brain.settled();
    const status = sent.filter((message) => message.type === "providers");
    expect(status[0]).toMatchObject({ providers: [{ provider: "gpt", available: false, until: clock.now() + 60_000 }, { available: true }, { available: true }] });
    brain.receive({ type: "order", order: ["claude", "gpt", "nobody" as Provider] });
    expect(brain.status().order).toEqual(["claude", "gpt"]);
    await brain.close();
  });

  it("reports the newest active model, provider fallback, and the idle model", async () => {
    const { brain, sent, programs, clock } = setup(["gpt", "claude", "deepseek"]);
    const shown = () => sent.findLast((message) => message.type === "providers")?.model;
    const input = (conversation: string) => brain.receive({ type: "input", conversation, input: { id: conversation, source: "owner", text: "hello", attachments: [] } });
    input("first");
    const first = (await programs.gpt.next()).handle;
    first.emit({ type: "model", model: "gpt-actual-first", effort: null });
    expect(shown()).toBe("gpt-actual-first");
    input("second");
    const second = (await programs.gpt.next()).handle;
    second.emit({ type: "model", model: "gpt-actual-second", effort: null });
    expect(shown()).toBe("gpt-actual-second");
    second.finish();
    expect(shown()).toBe("gpt-actual-first");
    first.emit({ type: "unavailable", reason: "limit", until: clock.now() + 60_000 });
    const fallback = (await programs.claude.next()).handle;
    expect(shown()).toBe("claude-model");
    fallback.emit({ type: "model", model: "claude-actual", effort: null });
    expect(shown()).toBe("claude-actual");
    fallback.finish();
    expect(shown()).toBe("claude-model");
    await brain.close();
  });
});
