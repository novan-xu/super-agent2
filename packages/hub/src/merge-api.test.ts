import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, type Ticket } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callBrainTool } from "./testing/brain-tools.js";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
import { keySet, signingKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { type FakeForge, fakeForge, fakeGitHubBase, fakeWoodpeckerServer } from "./testing/forge.js";
import { startTestHub } from "./testing/http.js";

const repository = "novan-xu/super-agent-sandbox";

let dataDir: string;
let forge: FakeForge;
let hub: Hub | undefined;

const credentials: CredentialSource = (account) => ({
  ok: true,
  credentials: { GH_TOKEN: `token-of-${account}`, GITHUB_TOKEN: `token-of-${account}`, WOODPECKER_SERVER: fakeWoodpeckerServer, WOODPECKER_TOKEN: "woodpecker-token" },
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-merge-api-"));
  forge = fakeForge();
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<Hub> {
  hub = await startTestHub({
    config: testConfig(dataDir),
    keySource: staticKeySource(keySet(await signingKey("key-1"))),
    clock: new TestClock(),
    targets: [],
    credentials,
    ticketWork: { begin: () => undefined, stop: () => undefined },
    forgeFetch: forge.fetch,
    gitHubBase: fakeGitHubBase,
  });
  return hub;
}

function verifyingTicket(running: Hub, conversation: string): Ticket {
  forge.repository(repository).issues.set(4, "open");
  forge.woodpecker.set(repository, { id: 6, active: true, configFile: "", pipelines: [] });
  const summary = { en: "Add a script", zh: "加一个脚本" };
  const opened = running.tickets.open({
    repository,
    issues: [{ repository, number: 4, url: `https://github.com/${repository}/issues/4`, title: { en: "Add a script", zh: "加一个脚本" }, summary }],
    title: { en: "Add a script", zh: "加一个脚本" },
    summary,
    kind: "feature",
    conversation,
  });
  forge.pull(repository, 12, "abc123", ["scripts/hello.js"], `sa2/ticket-${opened.id}-beef`);
  forge.tree(repository, "abc123", ["scripts/hello.js", ".woodpecker/check.yaml"]);
  running.tickets.change((writes) => {
    writes.move(opened.id, "working");
    writes.setBranch(opened.id, `sa2/ticket-${opened.id}-beef`);
    writes.setPullRequest(opened.id, 12, { en: "Added it", zh: "加好了" });
    writes.move(opened.id, "verifying");
  });
  return opened;
}

async function settled(running: Hub): Promise<void> {
  await running.verification.idle();
  await running.chains.idle();
}

describe("the brain's merge shortcut", () => {
  it("is offered to the brain and merges a ticket that waits for its pipeline, with the rules skipped", async () => {
    const running = await start();
    const conversation = running.conversations.create().id;
    const ticket = verifyingTicket(running, conversation);
    await settled(running);
    const waiting = await callBrainTool(running, "read_ticket", { ticket: ticket.id });
    expect(waiting.text).toContain("Verification: waiting (waiting: pipeline); rule workflows; change code; head abc123");
    expect(waiting.text).toContain("Waiting on the pipeline for 0 minutes; there is no usual time for this repository yet (0 green pipelines recorded), so the first-time allowance applies");
    const listed = (await (
      await fetch(`http://127.0.0.1:${running.address.port}${brainToolsPath}`, {
        method: "POST",
        headers: { authorization: `Bearer ${readFileSync(join(dataDir, "brain.token"), "utf8").trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toContain("merge_ticket");
    const merged = await callBrainTool(running, "merge_ticket", { ticket: ticket.id, reason: "The owner asked to merge it now" }, conversation);
    expect(merged.isError, merged.text).toBe(false);
    expect(merged.text).toContain(`Merged ticket ${ticket.id} with the rules skipped as commit merge-of-abc123`);
    await settled(running);
    expect(running.tickets.get(ticket.id)?.state).toBe("merged");
    expect(forge.merges).toEqual([{ repository, number: 12, sha: "abc123", method: "squash" }]);
    const notices = running.conversations.entries(conversation).filter((entry) => entry.kind === "notice");
    expect(notices.map((entry) => entry.kind === "notice" && entry.text)).toEqual([`工单 ${ticket.id} 已合并`]);
    const again = await callBrainTool(running, "merge_ticket", { ticket: ticket.id, reason: "Again" });
    expect(again).toEqual({ isError: true, text: `Nothing was merged: Ticket ${ticket.id} is already merged.` });
    expect(forge.merges).toHaveLength(1);
  });
});
