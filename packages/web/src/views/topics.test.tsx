import type { Conversation, OwnerEntry, StreamEntry } from "@super-agent2/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { codeScope, conversationRepositories, dailyScope, scopeOfTopic } from "../live/topic-scope.js";
import { ConversationTabs } from "./ConversationTabs.js";
import { ConversationView } from "./ConversationView.js";

const now = new Date(2026, 10, 18, 12).getTime();
const topic = (id: string, title: string, repository: string | null, working = false): Conversation =>
  ({ id, title, repository, state: working ? "working" : "idle", topicState: "active", provider: null, createdAt: now, updatedAt: now });
const project = topic("code", "Release notes", "owner/project", true);
const daily = topic("daily", "Weekly planning", null);
const pending = { ...topic("pending", "Investigate a bug", null), needsRepository: true } as const;
const list = [project, daily, pending];
const owner = (id: string, conversation: string, text: string, fields: Partial<OwnerEntry> = {}): OwnerEntry =>
  ({ id, conversation, seq: 1, at: now, kind: "owner", text, attachments: [], taken: true, ...fields });
const item = (position: number, topic: Conversation, entry: OwnerEntry): StreamEntry => ({ position, topic, entry });
const ignore = () => undefined;
const accepted = async () => true;
const topicActions = { rename: accepted, archive: accepted, merge: accepted, move: accepted };

describe("the conversation page", () => {
  it("shows only scoped topics with repository labels, reply context and possible matches", () => {
    const entries = [
      item(1, project, owner("first", project.id, "Review the migration")),
      item(2, daily, owner("daily-message", daily.id, "An everyday message")),
      item(3, pending, owner("pending-reply", pending.id, "Confirm the migration", { possibleMatch: project.id, quotedMessage: "first" })),
    ];
    const html = renderToStaticMarkup(<ConversationView conversation={null} scope={codeScope} state={null} list={list}
      stream={{ entries, turns: [], before: null, loading: false }} status="open" linked={true} model={null}
      hrefOf={(id) => `/conversations/${id}?scope=code`} open={ignore} streamHref="/conversations?scope=code" openStream={ignore}
      send={accepted} topicActions={topicActions} stop={ignore} loadOlder={ignore} now={now} />);
    expect(html).toContain('href="/conversations/code?scope=code"');
    expect(html).toContain("owner/project");
    expect(html).toContain("待定仓库");
    expect(html).toContain("正在回答");
    expect(html).toContain("移到 Release notes");
    expect(html).toContain("Release notes的话题操作");
    expect(html).toContain('aria-label="移到…"');
    expect(html).toContain('class="sent-quote od-truncate">Review the migration');
    expect(html).not.toContain("Weekly planning");
    expect(html).not.toContain("An everyday message");
  });

  it("uses a real transfer route and preserves a repository on a direct topic link", () => {
    const code = renderToStaticMarkup(<ConversationTabs scope={codeScope} transfer={false} repositories={["owner/project"]} navigate={ignore} />);
    expect(code).toContain('href="/conversations?scope=code" aria-current="page"');
    expect(code).toContain('href="/transfer"');
    expect(code).toContain("全部仓库");
    const transfer = renderToStaticMarkup(<ConversationTabs scope={dailyScope} transfer={true} repositories={[]} navigate={ignore} />);
    expect(transfer).toContain('href="/transfer" aria-current="page"');
    expect(transfer).not.toContain("<select");
    expect(scopeOfTopic(project)).toEqual({ kind: "repository", repository: "owner/project" });
    expect(scopeOfTopic(project, codeScope)).toBe(codeScope);
    expect(conversationRepositories(["OWNER/PROJECT", "owner/other"], list, codeScope)).toEqual(["owner/other", "owner/project"]);
  });
});
