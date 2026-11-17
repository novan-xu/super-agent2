import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainToolsPath, conversationHeader, deploymentFile, type Ticket } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialSource } from "./credentials.js";
import type { Hub } from "./hub.js";
import type { Job, Target } from "./targets.js";
import { keySet, signingKey, staticKeySource, TestClock, testConfig } from "./testing/access.js";
import { type FakeForge, fakeForge, fakeGitHubBase } from "./testing/forge.js";
import { startTestHub } from "./testing/http.js";
import { ManualTimer, settledTurn } from "./testing/timer.js";

const repository = "novan-xu/super-agent-sandbox";

let dataDir: string;
let forge: FakeForge;
let hub: Hub | undefined;
let clock: TestClock;
let timer: ManualTimer;
let service: { version: string | null; broken: Set<string>; jobs: Job[] };

const credentials: CredentialSource = (account) => ({ ok: true, credentials: { GH_TOKEN: `token-of-${account}`, GITHUB_TOKEN: `token-of-${account}` } });

function box(): Target {
  return {
    name: "box",
    run: (job) => {
      service.jobs.push(job);
      let exitCode = 0;
      if (job.command === "./deploy") {
        service.version = job.credentials["SUPERAGENT2_COMMIT"] ?? null;
      } else if (job.command === "./rollback") {
        service.version = job.credentials["SUPERAGENT2_PREVIOUS_COMMIT"] ?? null;
      } else if (job.command === "./health") {
        exitCode = service.version !== null && !service.broken.has(service.version) ? 0 : 1;
      }
      return { ended: Promise.resolve({ exitCode, signal: null }), stop: () => Promise.resolve() };
    },
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-deploy-api-"));
  forge = fakeForge();
  clock = new TestClock();
  timer = new ManualTimer(clock);
  service = { version: null, broken: new Set(), jobs: [] };
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
    clock,
    targets: [box()],
    credentials,
    ticketWork: { begin: () => undefined, stop: () => undefined },
    forgeFetch: forge.fetch,
    gitHubBase: fakeGitHubBase,
    deploymentSleep: timer.sleep,
  });
  return hub;
}

async function callTool(running: Hub, name: string, args: Record<string, unknown>, conversation?: string): Promise<{ isError: boolean; text: string }> {
  const response = await fetch(`http://127.0.0.1:${running.address.port}${brainToolsPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readFileSync(join(dataDir, "brain.token"), "utf8").trim()}`,
      "content-type": "application/json",
      ...(conversation === undefined ? {} : { [conversationHeader]: conversation }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { message: string } };
  return reply.result === undefined ? { isError: true, text: reply.error?.message ?? "" } : { isError: reply.result.isError, text: reply.result.content.map((part) => part.text).join("") };
}

function mergeWithDeployment(running: Hub, conversation: string, number: number, head: string): Ticket {
  forge.repository(repository).issues.set(number, "open");
  const summary = { en: "Change the page", zh: "改一下页面" };
  const opened = running.tickets.open({
    repository,
    issues: [{ repository, number, url: `https://github.com/${repository}/issues/${number}`, title: summary, summary }],
    title: summary,
    summary,
    kind: "feature",
    conversation,
  });
  forge.pull(repository, number + 100, head, ["src/page.ts"], `sa2/ticket-${opened.id}-beef`);
  forge.tree(repository, head, ["src/page.ts"]);
  forge.file(repository, head, deploymentFile, JSON.stringify({ target: "box", deploy: "./deploy", health: { command: "./health", everySeconds: 10, withinSeconds: 60 }, rollback: "./rollback" }));
  running.tickets.change((writes) => {
    writes.move(opened.id, "working");
    writes.setBranch(opened.id, `sa2/ticket-${opened.id}-beef`);
    writes.setPullRequest(opened.id, number + 100, { en: "Changed it", zh: "改好了" });
    writes.move(opened.id, "verifying");
  });
  return opened;
}

async function merge(running: Hub, ticket: Ticket): Promise<void> {
  await running.verification.idle();
  await running.chains.idle();
  expect(running.tickets.get(ticket.id)?.verification).toMatchObject({ rule: "none", deployment: true });
}

async function deployed(running: Hub, id: number): Promise<void> {
  for (;;) {
    await settledTurn();
    if (running.deployments.get(id)?.phase === "done") {
      await running.deployments.idle();
      return;
    }
    if (timer.sleeping > 0) {
      await timer.next();
    }
  }
}

function notices(running: Hub, conversation: string): string[] {
  return running.conversations.entries(conversation).flatMap((entry) => (entry.kind === "notice" ? [entry.text] : []));
}

describe("deployment by the brain", () => {
  it("changes nothing that is deployed when a ticket merges, and deploys the merged work when the brain asks, reporting the result in the conversation", async () => {
    const running = await start();
    const conversation = running.conversations.create().id;
    const ticket = mergeWithDeployment(running, conversation, 4, "abc123");
    await merge(running, ticket);
    expect(running.tickets.get(ticket.id)?.state).toBe("merged");
    expect(notices(running, conversation)).toEqual([`工单 ${ticket.id} 已合并，这次改动需要部署`]);
    expect(service.jobs).toEqual([]);
    expect(running.commands.list()).toEqual([]);
    expect(running.deployments.list()).toEqual([]);
    expect(running.tickets.get(ticket.id)?.deployedAt).toBeNull();

    const listed = (await (
      await fetch(`http://127.0.0.1:${running.address.port}${brainToolsPath}`, {
        method: "POST",
        headers: { authorization: `Bearer ${readFileSync(join(dataDir, "brain.token"), "utf8").trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["deploy_repository", "read_deployment"]));

    const started = await callTool(running, "deploy_repository", { repository, commit: "merge-of-abc123" }, conversation);
    expect(started.isError, started.text).toBe(false);
    expect(started.text).toContain(`Started deployment 1 of ${repository} at commit merge-of-abc123 on target box.`);
    await deployed(running, 1);
    expect(service.version).toBe("merge-of-abc123");
    expect(service.jobs.map((job) => job.command)).toEqual(["./deploy", "./health"]);
    expect(notices(running, conversation)).toEqual([`工单 ${ticket.id} 已合并，这次改动需要部署`, `${repository} 已部署到 merge-of-abc123，健康检查通过`]);
    expect(running.tickets.get(ticket.id)?.deployedAt).not.toBeNull();
    const read = await callTool(running, "read_deployment", { repository });
    expect(read.text).toContain(`Deployment 1 of ${repository} at commit merge-of-abc123 on target box succeeded`);
    expect(read.text).toContain(`Marked deployed: ticket ${ticket.id}`);
  });

  it("rolls a broken version back by itself, and the previous version answers again", async () => {
    const running = await start();
    const conversation = running.conversations.create().id;
    await merge(running, mergeWithDeployment(running, conversation, 4, "good"));
    expect((await callTool(running, "deploy_repository", { repository, commit: "merge-of-good" }, conversation)).isError).toBe(false);
    await deployed(running, 1);
    service.broken.add("merge-of-bad");
    await merge(running, mergeWithDeployment(running, conversation, 5, "bad"));
    const again = await callTool(running, "deploy_repository", { repository, commit: "main" }, conversation);
    expect(again.text).toContain("Started deployment 2 of novan-xu/super-agent-sandbox at commit merge-of-bad on target box.");
    expect(again.text).toContain("Previously deployed commit: merge-of-good.");
    const busy = await callTool(running, "deploy_repository", { repository, commit: "main" }, conversation);
    expect(busy).toMatchObject({ isError: true, text: expect.stringContaining("Deployment 2 of novan-xu/super-agent-sandbox at merge-of-bad is still running") });
    await deployed(running, 2);
    expect(running.deployments.get(2)?.result).toBe("rolled-back");
    expect(service.version).toBe("merge-of-good");
    expect(service.jobs.at(-1)?.command).toBe("./health");
    expect(notices(running, conversation).at(-1)).toBe(`${repository} 部署 merge-of-bad 没有成功，已回滚到 merge-of-good，旧版本恢复正常`);
  });

  it("refuses a commit whose repository declares no deployment", async () => {
    const running = await start();
    forge.tree(repository, "plain", ["README.md"]);
    const refused = await callTool(running, "deploy_repository", { repository, commit: "plain" });
    expect(refused).toEqual({
      isError: true,
      text: `${repository} has no ${deploymentFile} at plain, so it declares no deployment; nothing was deployed. A repository that should be deployed needs that file first, added as ordinary work through a ticket.`,
    });
    expect(service.jobs).toEqual([]);
  });
});
