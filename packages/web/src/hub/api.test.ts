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
