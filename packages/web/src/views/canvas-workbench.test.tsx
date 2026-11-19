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
  tickets: [first, second, third], topics: [topic], waiting: { ...initialWaiting, known: true, cards: [start] },
  actions: { answer: noop, start: noop, choose: noop, answerStuck: noop }, repository: undefined,
  selectRepository: noop, selected: null, selectTicket: noop, ticketHref: (id) => `/tickets/${id}`,
  panel: <div>Repository conversation</div>, focus: null, focused: noop, push: "hidden", togglePush: noop,
};

describe("workbench canvas", () => {
  it("lists repositories from tickets and topics, with all first and daily last", () => {
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} />);
    expect(html.indexOf("全部")).toBeLessThan(html.indexOf("org/one"));
    expect(html.indexOf("org/with-topic")).toBeLessThan(html.indexOf("日常"));
    expect(html).toContain("Repository conversation");
    expect(html).toContain("wb-card--pending");
    expect(html).toContain("在 #1 工作 1 之后");
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

  it("renders a started waiting card as queued in its predecessor's chain", () => {
    const queued = { ...second, state: "waiting" as const };
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} tickets={[first, queued]} waiting={{ ...initialWaiting, known: true }} />);
    expect(html.indexOf("工作 1")).toBeLessThan(html.indexOf("工作 2"));
    expect(html).toContain("已排队");
    expect(html).toContain("等 #1 合并");
    expect(html).not.toContain("wb-card--pending");
  });
});
