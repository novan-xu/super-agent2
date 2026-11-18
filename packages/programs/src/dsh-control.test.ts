import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ControlAgent, type ControlImageStore, type ControlMessage, createController } from "./dsh-control.js";

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
  it("steers only while a turn of that session is open", async () => {
    const busy = agent("running");
    const controller = createController({ get: (id) => (id === "s1" ? busy.value : undefined) });
    expect(await controller.command("steer", { sessionId: "s1", text: "早了" })).toBe("idle");
    controller.observe("s1", "turn/start");
    expect(await controller.command("steer", { sessionId: "s1", text: "顺便" })).toBe("steered");
    expect(await controller.command("steer", { sessionId: "s2", text: "别处" })).toBe("idle");
    controller.observe("s1", "turn/end");
    expect(await controller.command("steer", { sessionId: "s1", text: "晚了" })).toBe("idle");
    expect(busy.steered).toHaveLength(1);
    expect(busy.steered[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "顺便" }], source: { kind: "user" } });
    expect(Object.isFrozen(busy.steered[0])).toBe(true);
  });

  it("does not steer an agent that has gone idle", async () => {
    const idle = agent("idle");
    const controller = createController({ get: () => idle.value });
    controller.observe("s1", "turn/start");
    expect(await controller.command("steer", { sessionId: "s1", text: "x" })).toBe("idle");
    expect(idle.steered).toHaveLength(0);
  });

  it("adds images through dsh's own attachment store, and steers the text alone when the store refuses them", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dsh-control-"));
    const image = join(folder, "red.png");
    writeFileSync(image, Buffer.from([1, 2, 3]));
    const busy = agent("running");
    const saved: { readonly data: Uint8Array; readonly mediaType: string }[] = [];
    const store: ControlImageStore = {
      saveImages: (images) => {
        saved.push(...images);
        return Promise.resolve(images.map((_, index) => ({ ref: index })));
      },
    };
    const controller = createController({ get: () => busy.value }, () => store);
    controller.observe("s1", "turn/start");
    expect(await controller.command("steer", { sessionId: "s1", text: "看图", images: [{ path: image, mediaType: "image/png" }] })).toBe("steered");
    expect(saved).toEqual([{ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }]);
    expect(busy.steered[0]?.content).toEqual([{ type: "text", text: "看图" }, { type: "image", attachment: { ref: 0 } }]);
    const refusing = createController({ get: () => busy.value }, () => ({ saveImages: () => Promise.reject(new Error("IMAGE_TOO_LARGE")) }));
    refusing.observe("s1", "turn/start");
    expect(await refusing.command("steer", { sessionId: "s1", text: "大图", images: [{ path: image, mediaType: "image/png" }] })).toBe("steered");
    expect(busy.steered[1]?.content).toEqual([{ type: "text", text: "大图" }]);
  });

  it("cancels a running agent as the user and leaves an idle one alone", async () => {
    const busy = agent("running");
    const idle = agent("idle");
    const controller = createController({ get: (id) => (id === "busy" ? busy.value : id === "idle" ? idle.value : undefined) });
    expect(await controller.command("cancel", { sessionId: "busy" })).toBe("cancelled");
    expect(await controller.command("cancel", { sessionId: "idle" })).toBe("idle");
    expect(await controller.command("cancel", { sessionId: "none" })).toBe("idle");
    expect(busy.cancelled).toEqual(["user"]);
    expect(idle.cancelled).toEqual([]);
  });

  it("refuses requests it cannot read", async () => {
    const controller = createController({ get: () => undefined });
    await expect(controller.command("steer", {})).rejects.toThrow("sessionId");
    await expect(controller.command("steer", { sessionId: "s1" })).rejects.toThrow("text");
    await expect(controller.command("rewind", { sessionId: "s1" })).rejects.toThrow("unknown method");
  });
});
