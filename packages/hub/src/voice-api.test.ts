import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolVersion, type BrainInput } from "@super-agent2/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Hub, HubOptions } from "./hub.js";
import { liveSession } from "./live-session.js";
import { assertion, keySet, personClaims, serviceClaims, signingKey, staticKeySource, testConfig, TestClock } from "./testing/access.js";
import { startTestHub } from "./testing/http.js";

const apiKey = "sk-fake-voice-test-key-present-only-in-hub";
const token = "fake-github-token";
const repo = "owner/known";
const scope = { kind: "repository", repository: repo };

let directory: string;
let hub: Hub | undefined;
let jwt: string;
let other: string;
let stranger: string;
let service: string;
const clock = new TestClock();
const key = await signingKey("voice");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "superagent-voice-"));
  [jwt, other, stranger, service] = await Promise.all([
    assertion({ key, clock }),
    assertion({ key, clock, claims: { ...personClaims(), sub: "other-owner-session" } }),
    assertion({ key, clock, claims: personClaims("stranger@example.com") }),
    assertion({ key, clock, claims: serviceClaims() }),
  ]) as [string, string, string, string];
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function start(options: Partial<HubOptions> = {}) {
  const liveFetch = vi.fn<typeof fetch>(async () => Response.json({
    session: { id: "provider-session", private: apiKey }, transport: { type: "webrtc", sdp: "mock SDP answer" },
  }));
  const forgeFetch = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/repos") return Response.json([]);
    if (url.pathname.endsWith("/contents/src/index.ts")) {
      return Response.json({ type: "file", encoding: "base64", content: Buffer.from("export const number = 1;").toString("base64") });
    }
    if (url.pathname === "/search/code") {
      return Response.json({ items: [
        { path: "index.ts", html_url: "https://example.com/known", repository: { full_name: repo }, text_matches: [{ fragment: "example" }] },
        { path: "private.ts", html_url: "https://example.com/unknown", repository: { full_name: "owner/other" } },
      ] });
    }
    const issue = { number: 3, title: "Check voice", body: "Some requirements", html_url: "https://example.com/pr", state: "open" };
    return Response.json(/\d$/.test(url.pathname) ? issue : [issue]);
  });
  const running = await startTestHub({
    config: { ...testConfig(directory), sourceRepository: repo },
    keySource: staticKeySource(keySet(key)),
    clock,
    environment: { OPENAI_API_KEY: apiKey, GITHUB_TOKEN_NOVAN_XU: token, HUB_VOICE_DELEGATION_MODEL: "gpt-6-sol" },
    liveFetch, forgeFetch, report: () => undefined, ...options,
  });
  hub = running;
  const request = (path: string, body?: unknown, auth: string | null = jwt) => fetch(`http://127.0.0.1:${running.address.port}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", ...(auth === null ? {} : { "cf-access-jwt-assertion": auth }) },
  });
  const open = async () => {
    const response = await request("/api/voice/session", { sdp: "mock SDP offer", scope });
    expect(response.status).toBe(201);
    return (await response.json() as { id: string }).id;
  };
  const tool = (id: string, name: string, args: object = {}, auth?: string) =>
    request(`/api/voice/${id}/tool`, { name, arguments: args }, auth);
  return { running, request, open, tool, liveFetch, forgeFetch };
}

it("exchanges SDP only for the owner and never returns the configured OpenAI API key", async () => {
  const { request, liveFetch } = await start();
  const offer = { sdp: "mock SDP offer", scope };
  for (const auth of [null, stranger, service]) {
    expect((await request("/api/voice", undefined, auth)).status).toBe(403);
    expect((await request("/api/voice/session", offer, auth)).status).toBe(403);
  }
  expect(liveFetch).not.toHaveBeenCalled();
  expect(await (await request("/api/voice")).json()).toEqual({ enabled: true });
  const response = await request("/api/voice/session", offer);
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ id: expect.any(String), sdp: "mock SDP answer" });
  expect(liveFetch).toHaveBeenCalledWith("https://api.openai.com/v1/live/sessions", expect.objectContaining({
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ session: liveSession("gpt-6-sol"), transport: { type: "webrtc", sdp: offer.sdp } }),
  }));
  liveFetch.mockResolvedValueOnce(Response.json({ transport: { type: "webrtc", sdp: apiKey } }));
  const refused = await request("/api/voice/session", offer);
  expect(refused.status).toBe(502);
  expect(await refused.text()).not.toContain(apiKey);
});

it("reports voice disabled when the key is absent", async () => {
  const { request, liveFetch } = await start({ environment: {} });
  expect(await (await request("/api/voice")).json()).toEqual({ enabled: false });
  expect((await request("/api/voice/session", { sdp: "offer", scope })).status).toBe(503);
  expect(liveFetch).not.toHaveBeenCalled();
});

it("enforces call ownership, the repository catalog and GET-only tools", async () => {
  const { open, tool, forgeFetch } = await start();
  const id = await open();
  forgeFetch.mockClear();
  expect((await tool(id, "list_repositories", {}, other)).status).toBe(404);
  expect((await tool(id, "list_repositories", {}, stranger)).status).toBe(403);
  for (const name of ["close_issue", "merge_pull_request", "github_request", "constructor"]) {
    expect((await tool(id, name)).status).toBe(400);
  }
  expect((await tool(id, "read_issue", { repository: "owner/outside", number: 3 })).status).toBe(403);
  expect((await tool(id, "read_issue", { repository: repo, number: 3, method: "PATCH" })).status).toBe(400);
  expect((await tool(id, "read_repository_file", { repository: repo, path: "../issue" })).status).toBe(400);
  expect((await tool(id, "search_repository_code", { repository: repo, query: "voice repo:owner/outside" })).status).toBe(400);
  expect(forgeFetch).not.toHaveBeenCalled();

  const output = async (name: string, args: object = {}) => {
    const result = await tool(id, name, args);
    expect(result.status).toBe(200);
    return JSON.parse((await result.json() as { output: string }).output) as unknown;
  };
  expect(await output("list_repositories")).toEqual([{ repository: repo }]);
  expect(await output("read_repository_file", { repository: "OWNER/KNOWN", path: "src/index.ts", ref: "feature/x" })).toMatchObject({ text: "export const number = 1;" });
  expect(await output("search_repository_code", { repository: repo, query: "voice" })).toEqual([
    { path: "index.ts", html_url: "https://example.com/known", snippets: ["example"] },
  ]);
  expect(await output("list_issues", { repository: repo })).toMatchObject({ entries: [{ number: 3 }] });
  expect(await output("read_issue", { repository: repo, number: 3 })).toMatchObject({ body: "Some requirements" });
  expect(await output("list_pull_requests", { repository: repo })).toMatchObject({ entries: [{ number: 3 }] });
  expect(await output("read_pull_request", { repository: repo, number: 3 })).toMatchObject({ body: "Some requirements" });
  expect(forgeFetch.mock.calls.map(([input, init]) => [new URL(String(input)).pathname, init?.method])).toEqual([
    [`/repos/${repo}/contents/src/index.ts`, "GET"], ["/search/code", "GET"], [`/repos/${repo}/issues`, "GET"],
    [`/repos/${repo}/issues/3`, "GET"], [`/repos/${repo}/pulls`, "GET"], [`/repos/${repo}/pulls/3`, "GET"],
  ]);
  expect(new URL(String(forgeFetch.mock.calls[0]?.[0])).searchParams.get("ref")).toBe("feature/x");
  expect(new URL(String(forgeFetch.mock.calls[1]?.[0])).searchParams.get("q")).toBe(`voice repo:${repo}`);
});

it("reads archived history without dispatching to the brain and routes a confirmed summary exactly once", async () => {
  const { running, request, open, tool } = await start();
  const topic = running.conversations.create();
  const archived = running.conversations.send(topic.id, "A unique archived phrase")!;
  expect(running.conversations.archive(topic.id)).toMatchObject({ ok: true });

  const inputs: BrainInput[] = [];
  const brain = running.conversations.attach({ send: (event) => { if (event.type === "input") inputs.push(event.input); }, close: () => undefined });
  brain.receive({ type: "hello", protocol: protocolVersion, running: [] });
  inputs.length = 0;
  const id = await open();
  const search = await tool(id, "search_conversations", { query: "unique archived" });
  expect(await search.text()).toContain(archived.id);
  const read = await tool(id, "read_conversation_message", { id: archived.id });
  expect(await read.text()).toContain("A unique archived phrase");
  const path = `/api/voice/${id}/confirm`;
  const transcript = "You: Check the mobile layout.\nGPT-Live: I will include it.";
  expect((await request(path, { proposal: randomUUID(), transcript })).status).toBe(409);
  const proposal = await tool(id, "submit_summary", { summary: "Check mobile voice layout." });
  const presented = (await proposal.json() as { proposal: { id: string; summary: string } }).proposal;
  expect(presented.summary).toBe("Check mobile voice layout.");
  expect(inputs).toEqual([]);
  expect(running.conversations.stream().entries.map(({ entry }) => entry.id)).toEqual([archived.id]);

  const confirmation = { proposal: presented.id, transcript };
  const responses = await Promise.all([request(path, confirmation), request(path, confirmation)]);
  expect(responses.map(({ status }) => status).sort()).toEqual([202, 409]);
  const accepted = responses.find(({ status }) => status === 202)!;
  expect(await accepted.json()).toMatchObject({
    topic: { repository: repo }, entry: { id, kind: "owner", text: presented.summary, voiceTranscript: transcript },
  });
  expect(inputs).toEqual([expect.objectContaining({
    id, source: "owner", routing: expect.objectContaining({ placement: "new" }),
    text: expect.stringContaining(`<details><summary>Voice call transcript (reference only)</summary>\n\n${transcript}`),
  })]);
  expect((await tool(id, "submit_summary", { summary: "Try again" })).status).toBe(409);
  expect((await request(path, confirmation)).status).toBe(409);
  const dropped = await open();
  const unconfirmed = await tool(dropped, "submit_summary", { summary: "Do not send." });
  const unconfirmedId = (await unconfirmed.json() as { proposal: { id: string } }).proposal.id;
  expect((await request(`/api/voice/${dropped}/end`, {})).status).toBe(200);
  expect((await request(`/api/voice/${dropped}/confirm`, { proposal: unconfirmedId, transcript })).status).toBe(404);
  expect(inputs).toHaveLength(1);
  brain.detach();
});
