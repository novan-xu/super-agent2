import { describe, expect, it } from "vitest";
import { type ControlAgent, type ControlMessage, createController } from "./dsh-control.js";

function agent(status: string) {
  const steered: ControlMessage[] = [];
  const cancelled: string[] = [];
  const value: ControlAgent = {
    status,
    steer: (message) => {
      steered.push(message);
    },
    cancel: (cause) => {
      cancelled.push(cause.kind);
    },
  };
  return { value, steered, cancelled };
}

describe("the dsh control plugin", () => {
  it("steers only while a turn of that session is open", () => {
    const busy = agent("running");
    const controller = createController({ get: (id) => (id === "s1" ? busy.value : undefined) });
    expect(controller.command("steer", { sessionId: "s1", text: "早了" })).toBe("idle");
    controller.observe("s1", "turn/start");
    expect(controller.command("steer", { sessionId: "s1", text: "顺便" })).toBe("steered");
    expect(controller.command("steer", { sessionId: "s2", text: "别处" })).toBe("idle");
    controller.observe("s1", "turn/end");
    expect(controller.command("steer", { sessionId: "s1", text: "晚了" })).toBe("idle");
    expect(busy.steered).toHaveLength(1);
    expect(busy.steered[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "顺便" }], source: { kind: "user" } });
    expect(Object.isFrozen(busy.steered[0])).toBe(true);
  });

  it("does not steer an agent that has gone idle", () => {
    const idle = agent("idle");
    const controller = createController({ get: () => idle.value });
    controller.observe("s1", "turn/start");
    expect(controller.command("steer", { sessionId: "s1", text: "x" })).toBe("idle");
    expect(idle.steered).toHaveLength(0);
  });

  it("cancels a running agent as the user and leaves an idle one alone", () => {
    const busy = agent("running");
    const idle = agent("idle");
    const controller = createController({ get: (id) => (id === "busy" ? busy.value : id === "idle" ? idle.value : undefined) });
    expect(controller.command("cancel", { sessionId: "busy" })).toBe("cancelled");
    expect(controller.command("cancel", { sessionId: "idle" })).toBe("idle");
    expect(controller.command("cancel", { sessionId: "none" })).toBe("idle");
    expect(busy.cancelled).toEqual(["user"]);
    expect(idle.cancelled).toEqual([]);
  });

  it("refuses requests it cannot read", () => {
    const controller = createController({ get: () => undefined });
    expect(() => controller.command("steer", {})).toThrow("sessionId");
    expect(() => controller.command("steer", { sessionId: "s1" })).toThrow("text");
    expect(() => controller.command("rewind", { sessionId: "s1" })).toThrow("unknown method");
  });
});
