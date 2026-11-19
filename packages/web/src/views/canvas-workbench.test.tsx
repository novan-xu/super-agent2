import type { Conversation } from "@super-agent2/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { startCard, ticket, workStatus } from "../live/fixtures.js";
import { initialWaiting } from "../live/waiting.js";
import { CanvasWorkbench, type CanvasWorkbenchProps } from "./CanvasWorkbench.js";

const noop = () => undefined;
const topic: Conversation = { id: "topic", title: "Project topic", repository: "org/with-topic", state: "idle", topicState: "active", provider: null, createdAt: 1, updatedAt: 1 };
const waits = (id: number) => [{ ticket: id, deployment: false, waived: false }];
const first = ticket(1, { repository: "org/one", state: "working", work: workStatus() });
const second = ticket(2, { repository: "org/one", waits: waits(1), waitsFor: [1] });
const third = ticket(3, { repository: null, kind: "writing", form: "task", issues: [] });
const start = startCard(2, { ticket: second, before: [{ id: 1, zh: "工作 1", state: "working" }] });
const props: CanvasWorkbenchProps = {
  tickets: [first, second, third], topics: [topic], pinnedRepositories: [{ repository: "org/zzz" }, { repository: "org/empty" }], waiting: { ...initialWaiting, known: true, cards: [start] },
  actions: { answer: noop, start: noop, choose: noop, answerStuck: noop }, repository: undefined,
  selectRepository: noop, selected: null, selectTicket: noop, ticketHref: (id) => `/tickets/${id}`,
  panel: <div>Repository conversation</div>, focus: null, focused: noop, push: "hidden", togglePush: noop, rearrange: async () => true, rearranging: false,
};

describe("workbench canvas", () => {
  it("lists only pinned repositories, even without work, and keeps archived tickets under all", () => {
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} />);
    const rail = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(rail).toContain("org/empty");
    expect(rail).toContain("org/zzz");
    expect(rail).not.toContain("org/one");
    expect(rail).not.toContain("org/with-topic");
    expect(rail.indexOf("全部")).toBeLessThan(rail.indexOf("org/empty"));
    expect(rail.indexOf("org/empty")).toBeLessThan(rail.indexOf("org/zzz"));
    expect(rail.indexOf("org/zzz")).toBeLessThan(rail.indexOf("日常"));
    expect(html).toContain("Repository conversation");
    expect(html).toContain("wb-card--pending");
    expect(html).toContain("在 #1 工作 1 之后");
  });

  it("sorts by alias while retaining the full repository in the tooltip", () => {
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} pinnedRepositories={[{ repository: "org/zzz", alias: "Alpha" }, { repository: "org/empty" }]} />);
    const rail = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(rail).toContain('title="org/zzz"');
    expect(rail.indexOf("Alpha")).toBeLessThan(rail.indexOf("org/empty"));
  });

  it("scopes work to a repository or daily tickets", () => {
    const project = renderToStaticMarkup(<CanvasWorkbench {...props} repository="org/one" />);
    expect(project).toContain("工作 1");
    expect(project).toContain("工作 2");
    expect(project).not.toContain("工作 3");
    const daily = renderToStaticMarkup(<CanvasWorkbench {...props} repository={null} />);
    expect(daily).toContain("工作 3");
    expect(daily).not.toContain("工作 1");
  });

  it("lists pending and working repository-less tasks in daily", () => {
    const pending = { ...third, state: "pending" as const };
    const working = ticket(4, { repository: null, kind: "writing", form: "task", issues: [], state: "working" });
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} repository={null} tickets={[pending, working]} waiting={{ ...initialWaiting, known: true, cards: [startCard(3, { ticket: pending })] }} />);
    expect(html).toContain("工作 3");
    expect(html).toContain("工作 4");
    expect(html).toContain("wb-card--pending");
  });

  it("renders a started waiting card as queued in its predecessor's chain", () => {
    const queued = { ...second, state: "waiting" as const };
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} tickets={[first, queued]} waiting={{ ...initialWaiting, known: true }} />);
    expect(html.indexOf("工作 1")).toBeLessThan(html.indexOf("工作 2"));
    expect(html).toContain("已排队");
    expect(html).toContain("等 #1 合并");
    expect(html).not.toContain("wb-card--pending");
  });
});
