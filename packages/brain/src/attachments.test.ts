import { join } from "node:path";
import type { BrainAttachment, BrainMessage, Provider } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { createBrain } from "./brain.js";
import { attachmentPath, describeHistory, turnPrompt } from "./prompt.js";
import { FakeProgram } from "./testing/fake.js";

const root = join("/var", "link", "attachments");

const photo: BrainAttachment = { id: "a".repeat(32), name: "photo.jpg", size: 3_000_000, mediaType: "image/jpeg", path: `${"a".repeat(32)}/photo.jpg` };
const sheet: BrainAttachment = { id: "b".repeat(32), name: "budget.xlsx", size: 2_048, mediaType: "application/vnd.ms-excel", path: `${"b".repeat(32)}/budget.xlsx` };

function setup() {
  const sent: BrainMessage[] = [];
  const program = new FakeProgram("claude");
  const brain = createBrain({
    adapters: new Map<Provider, FakeProgram>([["claude", program]]),
    order: ["claude"],
    clock: { now: () => 1 },
    transport: {
      send: (message) => sent.push(message),
      prepare: (call) => Promise.resolve({ type: "prepared", request: call.conversation, session: null, history: [], memory: null }),
    },
    tools: { url: "http://hub/brain/mcp", token: "t" },
    workspace: "/tmp/workspace",
    attachments: root,
  });
  return { brain, sent, program };
}

describe("the brain and the owner's attachments", () => {
  it("names every file's place and id in the message, and gives the images to the program as images", async () => {
    const { brain, program } = setup();
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "", attachments: [photo, sheet] } });
    const started = await program.next();
    expect(started.text).toContain(`at ${join(root, photo.id, "photo.jpg")}`);
    expect(started.text).toContain(`attachment id ${sheet.id}, at ${join(root, sheet.id, "budget.xlsx")}`);
    expect(started.handle.images[0]).toEqual([{ path: join(root, photo.id, "photo.jpg"), mediaType: "image/jpeg", size: 3_000_000 }]);
    await brain.close();
  });

  it("does the same for a message taken into a running turn", async () => {
    const { brain, program } = setup();
    brain.receive({ type: "input", conversation: "c1", input: { id: "i1", source: "owner", text: "hello", attachments: [] } });
    const started = await program.next();
    brain.receive({ type: "input", conversation: "c1", input: { id: "i2", source: "owner", text: "and this", attachments: [photo] } });
    const steered = await program.next("steer");
    expect(steered.text).toContain("and this");
    expect(steered.text).toContain(join(root, photo.id, "photo.jpg"));
    expect(started.handle.images.at(-1)).toEqual([{ path: join(root, photo.id, "photo.jpg"), mediaType: "image/jpeg", size: 3_000_000 }]);
    await brain.close();
  });

  it("keeps the files in the history another provider is given", () => {
    const text = describeHistory([{ kind: "owner", text: "看这个", attachments: [sheet] }], root);
    expect(text).toContain(join(root, sheet.id, "budget.xlsx"));
    expect(turnPrompt([], [{ id: "i", source: "owner", text: "only text", attachments: [] }], null, root)).toBe("only text");
  });

  it("refuses a path that would leave the attachments folder", () => {
    expect(() => attachmentPath(root, { path: "../secrets/brain.token" })).toThrow();
    expect(() => attachmentPath(root, { path: "/etc/passwd" })).toThrow();
    expect(attachmentPath(root, photo)).toBe(join(root, photo.id, "photo.jpg"));
  });
});
