import type { AttachmentUpload } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import type { Answer, Failure } from "../hub/api.js";
import { nameOf, upload, type UploadApi } from "./upload.js";

const id = "c".repeat(32);

class FakeHub implements UploadApi {
  received = 0;
  readonly calls: string[] = [];
  failAt: number | undefined;
  failure: Failure = "network";

  constructor(readonly size: number) {}

  private answer(): Answer<AttachmentUpload> {
    return { ok: true, value: { attachment: { id, name: "f", size: this.size, mediaType: "x" }, received: this.received } };
  }

  createAttachment(name: string, size: number): Promise<Answer<AttachmentUpload>> {
    this.calls.push(`create ${name} ${size}`);
    return Promise.resolve(this.answer());
  }

  uploadState(): Promise<Answer<AttachmentUpload>> {
    this.calls.push("state");
    return Promise.resolve(this.answer());
  }

  uploadPart(_id: string, offset: number, part: Blob): Promise<Answer<AttachmentUpload>> {
    this.calls.push(`part ${offset} ${part.size}`);
    if (this.failAt === offset) {
      this.failAt = undefined;
      return Promise.resolve({ ok: false, error: this.failure });
    }
    if (offset !== this.received) {
      return Promise.resolve({ ok: false, error: "conflict" });
    }
    this.received = offset + part.size;
    return Promise.resolve(this.answer());
  }
}

function source(size: number, name = "clip.mov", type = "video/quicktime") {
  const blob = new Blob([new Uint8Array(size)]);
  return { name, size, type, slice: (start: number, end: number) => blob.slice(start, end) };
}

describe("uploading an attachment", () => {
  it("sends it in parts and reports the progress", async () => {
    const hub = new FakeHub(10);
    const seen: number[] = [];
    expect(await upload(source(10), "clip.mov", hub, null, (_id, received) => seen.push(received), 4)).toEqual({ ok: true, id });
    expect(hub.calls).toEqual(["create clip.mov 10", "part 0 4", "part 4 4", "part 8 2"]);
    expect(seen).toEqual([0, 4, 8, 10]);
  });

  it("stops at a failed part and goes on from what the hub has when tried again", async () => {
    const hub = new FakeHub(10);
    hub.failAt = 4;
    const first = await upload(source(10), "clip.mov", hub, null, () => undefined, 4);
    expect(first).toEqual({ ok: false, id });
    hub.calls.length = 0;
    expect(await upload(source(10), "clip.mov", hub, id, () => undefined, 4)).toEqual({ ok: true, id });
    expect(hub.calls).toEqual(["state", "part 4 4", "part 8 2"]);
  });

  it("asks the hub where it stands after a conflict, and finishes an empty file at once", async () => {
    const hub = new FakeHub(6);
    hub.received = 2;
    expect(await upload(source(6), "clip.mov", hub, id, () => undefined, 4)).toEqual({ ok: true, id });
    const empty = new FakeHub(0);
    expect(await upload(source(0, "empty.txt", "text/plain"), "empty.txt", empty, null, () => undefined)).toEqual({ ok: true, id });
    expect(empty.calls).toEqual(["create empty.txt 0"]);
  });

  it("names a pasted image that came without a name", () => {
    expect(nameOf(source(1, "photo.jpg", "image/jpeg"), 0, 0)).toBe("photo.jpg");
    expect(nameOf(source(1, "", "image/png"), 1, Date.UTC(2026, 10, 17, 8, 30))).toBe("2026-11-17T08-30-00-000Z-2.png");
  });
});
