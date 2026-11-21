import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Attachment, storedName } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { workPaths } from "./workplace.js";
import { taskPaths } from "./task.js";
import { repository, home, programs, sent, git, start, task, events, kinds, writingTask, attachmentRequests, serveAttachments } from "./testing/works.js";

describe("attachments on the runner", () => {
  const photo: Attachment = { id: "a".repeat(32), name: "../../photo.png", size: 5, mediaType: "image/png" };
  const note: Attachment = { id: "b".repeat(32), name: "note.txt", size: 9, mediaType: "text/plain" };
  const files = new Map([
    [photo.id, Buffer.from("PNG!!")],
    [note.id, Buffer.from("code word")],
  ]);

  it("fetches a message's files from the hub in parts into the ticket's folder outside the worktree, and shows the images to the program", async () => {
    const works = start();
    void serveAttachments(works, files, 2);
    works.receive({ type: "work.start", task: task(31) });
    const handle = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 31, attempt: 1, id: "m-a", from: "owner", text: "", attachments: [photo, note] });
    await programs.changed.until(() => handle.steered.length === 1);
    const paths = workPaths(home, repository, 31);
    const photoPath = join(paths.folder, "attachments", photo.id, storedName(photo.name));
    const notePath = join(paths.folder, "attachments", note.id, "note.txt");
    expect(readFileSync(photoPath, "utf8")).toBe("PNG!!");
    expect(readFileSync(notePath, "utf8")).toBe("code word");
    expect(photoPath.startsWith(paths.worktree)).toBe(false);
    expect(storedName(photo.name)).not.toContain("/");
    expect(handle.steered[0]).toContain(notePath);
    expect(handle.steered[0]).toContain(photoPath);
    expect(handle.images.at(-1)).toEqual([{ path: photoPath, mediaType: "image/png", size: 5 }]);
    expect(attachmentRequests().map((message) => message.offset)).toEqual([0, 2, 4, 0, 2, 4, 6, 8]);
    await sent.until(() => kinds(31).includes("message"));
    expect(events(31).find((message) => message.event.kind === "message")?.event).toEqual({ kind: "message", id: "m-a", from: "owner", text: "", attachments: [photo, note], delivery: "steered" });
    works.receive({ type: "work.message", ticket: 31, attempt: 1, id: "m-a", from: "owner", text: "", attachments: [photo, note] });
    await works.idle();
    expect(handle.steered).toHaveLength(1);
  });

  it("keeps what arrived when the link drops, and finishes the file when the hub gives the message again", async () => {
    const works = start();
    works.receive({ type: "work.start", task: task(32) });
    const handle = await programs.prompted(1);
    const served = serveAttachments(works, files, 2, 2);
    works.receive({ type: "work.message", ticket: 32, attempt: 1, id: "m-b", from: "owner", text: "look", attachments: [photo] });
    await served;
    await sent.until(() => attachmentRequests().length === 3);
    works.disconnected();
    await works.idle();
    expect(kinds(32)).not.toContain("message");
    const file = join(workPaths(home, repository, 32).folder, "attachments", photo.id, storedName(photo.name));
    expect(readFileSync(file, "utf8")).toBe("PNG!");
    const before = attachmentRequests().length;
    const resumed = sent.until(() => attachmentRequests().length > before).then(() => {
      const asked = attachmentRequests().at(-1);
      if (asked !== undefined) {
        works.receive({ type: "work.attachment.part", ticket: 32, attempt: 1, attachment: photo.id, offset: asked.offset, data: Buffer.from("!").toString("base64"), problem: null });
      }
      return asked?.offset;
    });
    works.receive({ type: "work.message", ticket: 32, attempt: 1, id: "m-b", from: "owner", text: "look", attachments: [photo] });
    expect(await resumed).toBe(4);
    await programs.changed.until(() => handle.steered.length === 1);
    expect(readFileSync(file, "utf8")).toBe("PNG!!");
  });

  it("puts a task ticket's attached material in the input folder under its name", async () => {
    const works = start();
    void serveAttachments(works, files, 8);
    works.receive({
      type: "work.task",
      task: writingTask(33, { materials: [{ name: "contract.txt", source: "attached by the owner", text: null, attachment: note }] }),
    });
    const handle = await programs.prompted(1);
    expect(readFileSync(join(taskPaths(home, 33).worktree, "input", "contract.txt"), "utf8")).toBe("code word");
    expect(handle.prompts[0]).toContain("input/contract.txt");
  });
});

describe("attachments across a chain's pieces", () => {
  it("keeps a fetched file when the folder moves to the next branch, and does not fetch it again", async () => {
    const note: Attachment = { id: "c".repeat(32), name: "spec.md", size: 4, mediaType: "text/markdown" };
    const works = start();
    void serveAttachments(works, new Map([[note.id, Buffer.from("spec")]]), 8);
    works.receive({ type: "work.start", task: task(35) });
    const first = await programs.prompted(1);
    works.receive({ type: "work.message", ticket: 35, attempt: 1, id: "m-c", from: "owner", text: "read it", attachments: [note] });
    await programs.changed.until(() => first.steered.length === 1);
    const paths = workPaths(home, repository, 35);
    const file = join(paths.folder, "attachments", note.id, "spec.md");
    expect(readFileSync(file, "utf8")).toBe("spec");
    works.receive({ type: "work.start", task: task(35, { attempt: 2, branch: "sa2/ticket-35-beef", merged: [11], session: "thread-35", note: "Pull request #70 is merged into main." }) });
    await programs.changed.until(() => programs.handles.length === 2);
    const second = await programs.prompted(1);
    expect((await git(paths.worktree).must(["rev-parse", "--abbrev-ref", "HEAD"], paths.worktree)).trim()).toBe("sa2/ticket-35-beef");
    expect(readFileSync(file, "utf8")).toBe("spec");
    const asked = attachmentRequests().length;
    works.receive({ type: "work.message", ticket: 35, attempt: 2, id: "m-d", from: "owner", text: "again", attachments: [note] });
    await programs.changed.until(() => second.steered.length === 1);
    expect(second.steered[0]).toContain(file);
    expect(attachmentRequests()).toHaveLength(asked);
  });
});
