import type { Conversation, OwnerEntry, StreamEntry } from "@super-agent2/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { codeScope, conversationRepositories, dailyScope, scopeOfTopic, workbenchScope } from "../live/topic-scope.js";
import { ConversationTabs } from "./ConversationTabs.js";
import { ConversationView } from "./ConversationView.js";
import { TopicActionDialog } from "./TopicActions.js";

const now = new Date(2026, 10, 18, 12).getTime();
const topic = (id: string, title: string, repository: string | null, working = false): Conversation =>
  ({ id, title, repository, state: working ? "working" : "idle", topicState: "active", provider: null, createdAt: now, updatedAt: now });
const project = topic("code", "Release notes", "owner/project", true);
const daily = topic("daily", "Weekly planning", null);
const pending = { ...topic("pending", "Investigate a bug", null), needsRepository: true } as const;
const list = [project, daily, pending];
const owner = (id: string, conversation: string, text: string, fields: Partial<OwnerEntry> = {}): OwnerEntry =>
  ({ id, conversation, seq: 1, at: now, kind: "owner", text, attachments: [], taken: true, ...fields });
const item = (position: number, topic: Conversation, entry: OwnerEntry) => ({ position, topic, entry });
const ignore = () => undefined;
const accepted = async () => true;
const topicActions = { rename: accepted, archive: accepted, merge: accepted, move: accepted };

function renderStream(entries: readonly StreamEntry[]) {
  return renderToStaticMarkup(<ConversationView conversation={null} scope={codeScope} state={null} list={list}
    stream={{ entries, turns: [], before: null, loading: false }} status="open" linked={true} model={null}
    hrefOf={(id) => `/conversations/${id}?scope=code`} open={ignore} streamHref="/conversations?scope=code" openStream={ignore}
    send={accepted} topicActions={topicActions} stop={ignore} loadOlder={ignore} now={now} />);
}

describe("the conversation page", () => {
  it("scopes a workbench panel to its selected repository or daily stream", () => {
    expect(workbenchScope("owner/project")).toEqual({ kind: "repository", repository: "owner/project" });
    expect(workbenchScope(null)).toEqual(dailyScope);
    expect(workbenchScope(undefined)).toEqual(codeScope);
  });

  it("shows only scoped topics with repository labels, reply context and possible matches", () => {
    const entries = [
      item(1, project, owner("first", project.id, "Review the migration")),
      item(2, daily, owner("daily-message", daily.id, "An everyday message")),
      item(3, pending, owner("pending-reply", pending.id, "Confirm the migration", { possibleMatch: project.id, quotedMessage: "first" })),
    ];
    const html = renderStream(entries);
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

  it("offers a one-tap new topic beside the latest joined message's topic label", () => {
    const opened = item(1, pending, owner("opened", pending.id, "Opened by routing", { placement: "router-opened" }));
    const joined = item(2, project, owner("joined", project.id, "Joined by routing", { seq: 2, placement: "router-joined" }));
    const another = item(3, pending, owner("another", pending.id, "Latest in another topic", { seq: 2, placement: "owner" }));
    const later = item(4, project, owner("later", project.id, "Latest in the same topic", { seq: 3, placement: "owner" }));
    const button = '<button class="topic-split" type="button">新话题</button>';
    const html = renderStream([opened, joined, another]);
    expect(html.split(button)).toHaveLength(2);
    expect(html).toContain(`owner/project</span></a><span class="topic-split-slot">${button}`);
    expect(html).toMatch(/class="topic-split-slot">.*Joined by routing/);
    expect(renderStream([opened, joined, another, later])).not.toContain(button);
    expect(renderStream([opened, { ...joined, latestOwner: false }])).not.toContain(button);
    expect(renderStream([opened, { ...joined, entry: { ...joined.entry, placement: "owner" } }])).not.toContain(button);
  });

  it("offers a new topic in the move dialog even if there are no existing destinations", () => {
    const render = (topics: readonly Conversation[]) => renderToStaticMarkup(
      <TopicActionDialog edit={{ source: project.id, message: "direct" }} list={topics} actions={topicActions} done={ignore} />,
    );
    expect(render([project])).toContain('<option value=":new">新话题</option>');
    const html = render([project, daily]);
    expect(html).toContain('<option value=":new">新话题</option>');
    expect(html).toContain('<option value="daily">Weekly planning</option>');
    expect(html).not.toContain('<option value="code">');
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
    expect(scopeOfTopic(undefined)).toEqual(codeScope);
    expect(scopeOfTopic(project, codeScope)).toBe(codeScope);
    expect(conversationRepositories(["OWNER/PROJECT", "owner/other"], list, codeScope)).toEqual(["owner/other", "owner/project"]);
  });
});
