import { describe, expect, it, vi } from "vitest";
import { createBrain } from "./brain.js";
import { FakeProgram } from "./testing/fake.js";
import { updatePrograms } from "./program-update.js";

describe("brain program updates", () => {
  it("installs only newer latest versions and keeps going after a failure", async () => {
    const report = vi.fn();
    const install = vi.fn(async (name: string) => { if (name === "codex") throw new Error("offline"); });
    await updatePrograms({
      current: async (name) => name === "dsh" ? "0.2.1-rc.2" : "1.0.0",
      latest: async (name) => name.includes("dsh") ? "0.2.0" : "1.1.0",
      install,
    }, report);
    expect(install.mock.calls.map((call) => call[0])).toEqual(["codex", "claude"]);
    expect(report.mock.calls.flat().join(" ")).toContain("offline");
    expect(report.mock.calls.flat().join(" ")).toContain("latest is older");
  });

  it("waits for a turn, closes the idle process, queues input and resumes the session", async () => {
    const program = new FakeProgram("gpt");
    const brain = createBrain({
      adapters: new Map([["gpt", program]]), order: ["gpt"],
      transport: { send: () => undefined, prepare: async () => ({ type: "prepared", request: "r", session: "saved", history: [], memory: null }) },
      clock: { now: () => 0 }, tools: { url: "http://localhost", token: "t" }, workspace: ".",
    });
    const input = (id: string) => brain.receive({ type: "input", conversation: "c", input: { id, source: "owner", text: id, attachments: [] } });
    input("one");
    const first = await program.next();
    let release = () => {};
    const action = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const update = brain.maintenance(action);
    expect(action).not.toHaveBeenCalled();
    first.handle.finish();
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(first.handle.closed).toBe(true);
    input("two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(program.handles).toHaveLength(1);
    release();
    await update;
    const second = await program.next();
    expect(second.handle.options.session).toBe("saved");
    second.handle.finish();
    await brain.close();
  });
});
