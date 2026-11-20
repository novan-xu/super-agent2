import { afterEach, describe, expect, it, vi } from "vitest";
import { hubApi } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("workbench rearrangement API", () => {
  it("posts the selected scope and reads the created conversation", async () => {
    const conversation = { id: "topic", title: "Rearrange", state: "idle", topicState: "active", repository: "org/one", provider: null, createdAt: 1, updatedAt: 1 };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversation }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await hubApi.rearrange("org/one")).toEqual({ ok: true, value: { conversation } });
    expect(fetcher).toHaveBeenCalledWith("/api/workbench/rearrange", expect.objectContaining({ method: "POST", body: '{"repository":"org/one"}' }));
    await hubApi.rearrange(null);
    expect(fetcher.mock.calls[1]?.[1].body).toBe('{"repository":null}');
    await hubApi.rearrange(undefined);
    expect(fetcher.mock.calls[2]?.[1].body).toBe('{}');
  });
});

describe("send and preview API", () => {
  it("posts the send's id and passes each request's signal", async () => {
    const entry = { id: "4f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", conversation: "topic", seq: 1, at: 1, kind: "owner", text: "Hi", attachments: [], taken: false };
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ entry }), { status: 202 })));
    vi.stubGlobal("fetch", fetcher);
    const leaving = new AbortController();
    await hubApi.send("topic", "Hi", [], undefined, { id: entry.id, signal: leaving.signal });
    expect(fetcher).toHaveBeenLastCalledWith("/api/conversations/topic/messages", expect.objectContaining({
      body: JSON.stringify({ id: entry.id, text: "Hi", attachments: [] }), signal: leaving.signal,
    }));
    await hubApi.sendToStream("Hi", [], undefined, { kind: "daily" }, undefined, { id: entry.id, signal: leaving.signal });
    expect(fetcher).toHaveBeenLastCalledWith("/api/stream", expect.objectContaining({
      body: JSON.stringify({ id: entry.id, text: "Hi", attachments: [], scope: { kind: "daily" } }), signal: leaving.signal,
    }));
    await hubApi.previewStream({ scope: { kind: "daily" }, text: "Hi", attachmentNames: [] }, leaving.signal);
    expect(fetcher).toHaveBeenLastCalledWith("/api/stream/preview", expect.objectContaining({ signal: leaving.signal }));
    fetcher.mockImplementation(() => Promise.reject(new DOMException("aborted", "AbortError")));
    leaving.abort();
    expect(await hubApi.sendToStream("Hi", [], undefined, undefined, undefined, { signal: leaving.signal })).toEqual({ ok: false, error: "network" });
  });
});
