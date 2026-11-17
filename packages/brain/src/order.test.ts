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

describe("the brain's provider order", () => {
  it("is changed by the hub and applies to the next message", async () => {
    const { brain, sent, programs } = setup(["gpt", "claude", "deepseek"]);
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "hello" } });
    (await programs.gpt.next()).handle.finish("hi");
    await brain.settled();
    brain.receive({ type: "order", order: ["claude", "gpt", "deepseek"] });
    expect(sent.at(-1)).toMatchObject({ type: "providers", order: ["claude", "gpt", "deepseek"] });
    brain.receive({ type: "input", conversation: "c1", input: { id: "i2", source: "owner", text: "again" } });
    (await programs.claude.next()).handle.finish("hi");
    await brain.settled();
    expect(startedWith(sent)).toEqual(["gpt", "claude"]);
    await brain.close();
  });

  it("tells the hub each provider's state when it changes, and keeps only providers it has a program for", async () => {
    const { brain, sent, programs, clock } = setup(["gpt", "claude", "deepseek"]);
    expect(brain.status()).toEqual({
      type: "providers",
      order: ["gpt", "claude", "deepseek"],
      providers: [
        { provider: "gpt", model: "gpt-model", effort: "high", available: true, until: null },
        { provider: "claude", model: "claude-model", effort: "high", available: true, until: null },
        { provider: "deepseek", model: "deepseek-model", effort: "high", available: true, until: null },
      ],
    });
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "hello" } });
    (await programs.gpt.next()).handle.emit({ type: "unavailable", reason: "usage limit", until: clock.now() + 60_000 });
    (await programs.claude.next()).handle.finish("hi");
    await brain.settled();
    const status = sent.filter((message) => message.type === "providers");
    expect(status[0]).toMatchObject({ providers: [{ provider: "gpt", available: false, until: clock.now() + 60_000 }, { available: true }, { available: true }] });
    brain.receive({ type: "order", order: ["claude", "gpt", "nobody" as Provider] });
    expect(brain.status().order).toEqual(["claude", "gpt"]);
    await brain.close();
  });
});
