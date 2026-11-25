import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { startCard, ticket, workStatus } from "../live/fixtures.js";
import { initialWaiting } from "../live/waiting.js";
import { CanvasWorkbench, type CanvasWorkbenchProps } from "./CanvasWorkbench.js";

const noop = () => undefined;
const waits = (id: number) => [{ ticket: id, deployment: false, waived: false }];
const first = ticket(1, { repository: "org/one", state: "working", work: workStatus() });
const second = ticket(2, { repository: "org/one", waits: waits(1), waitsFor: [1] });
const third = ticket(3, { repository: null, kind: "writing", form: "task", issues: [] });
const start = startCard(2, { ticket: second, before: [{ id: 1, zh: "工作 1", state: "working" }] });
const props: CanvasWorkbenchProps = {
  tickets: [first, second, third], pinnedRepositories: [{ repository: "org/zzz" }, { repository: "org/empty" }], waiting: { ...initialWaiting, known: true, cards: [start] },
  actions: { answer: noop, start: noop, choose: noop, answerStuck: noop }, repository: undefined,
  selectRepository: noop, selected: null, selectTicket: noop, ticketHref: (id) => `/tickets/${id}`,
  pane: "canvas", setPane: noop, panel: <div>Repository conversation</div>, focus: null, focused: noop, push: "hidden", togglePush: noop, rearrange: async () => true, rearranging: false,
};

describe("workbench canvas", () => {
  it("scopes work to a repository or daily tickets", () => {
    const related = ticket(4, { project: "Org/One", repository: null, form: "task", kind: "operation", issues: [] });
    const tickets = [...props.tickets, related];
    const project = renderToStaticMarkup(<CanvasWorkbench {...props} repository="org/one" tickets={tickets} />);
    expect(project).toContain("工作 1");
    expect(project).toContain("工作 2");
    expect(project).not.toContain("工作 3");
    expect(project).toContain("工作 4");
    const daily = renderToStaticMarkup(<CanvasWorkbench {...props} repository={null} tickets={tickets} />);
    expect(daily).not.toContain("wb-gutter");
    expect(daily).toContain("工作 3");
    expect(daily).not.toContain("工作 1");
    expect(daily).not.toContain("工作 4");
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
    expect(html).toContain("等工单 AA 合并");
    expect(html).not.toContain("wb-card--pending");
  });
  it("renders forks and merges in one timeline with accessible predecessor labels", () => {
    const branch = ticket(3, { repository: "org/one", waits: waits(1), waitsFor: [1] });
    const merge = ticket(4, { repository: "org/one", waits: [...waits(2), ...waits(3)], waitsFor: [2, 3] });
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} tickets={[merge, branch, second, first]} waiting={{ ...initialWaiting, known: true }} />);
    expect(html).toContain('class="wb-chain wb-chain--linked"');
    expect((html.match(/class="wb-rail-dot /g) ?? [])).toHaveLength(4);
    expect(html).toContain('class="wb-rail-dot dot dot--ok"');
    expect(html.indexOf('data-ticket="1"')).toBeLessThan(html.indexOf('data-ticket="2"'));
    expect(html.indexOf('data-ticket="2"')).toBeLessThan(html.indexOf('data-ticket="3"'));
    expect(html.indexOf('data-ticket="3"')).toBeLessThan(html.indexOf('data-ticket="4"'));
    expect((html.match(/class="wb-lane-clearance"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('class="sr-only">在 AB 工作 2、AC 工作 3 之后');
    expect(html).not.toContain("wb-branch");
  });

  it("shows ticket codes on reference cards too", () => {
    const predecessor = ticket(1, { repository: "org/other", state: "working", work: workStatus() });
    const html = renderToStaticMarkup(<CanvasWorkbench {...props} tickets={[predecessor, second]} repository="org/one" waiting={{ ...initialWaiting, known: true }} />);
    expect(html).toContain('class="wb-card wb-card--reference" aria-label="工作 1 AA"');
    expect(html).toContain('<span class="mono wb-ticket-code">AA</span>');
  });
});
