import { text } from "@super-agent2/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { startCard, ticket, workStatus } from "../live/fixtures.js";
import { initialWaiting } from "../live/waiting.js";
import { RepositoryTabs } from "./RepositoryTabs.js";

it("renders fixed tabs, counts and status in persistent opening order", () => {
  const running = ticket(1, { repository: "org/running", state: "working", work: workStatus() });
  const pending = ticket(2, { repository: "org/waiting" });
  const html = renderToStaticMarkup(<RepositoryTabs repositories={[
    { repository: "org/waiting", account: "novan-xu", chosen: false, pinned: true, pinnedOrder: 2 },
    { repository: "org/running", account: "novan-xu", chosen: false, pinned: true, pinnedOrder: 1, alias: "Running" },
    { repository: "org/legacy", account: "novan-xu", chosen: false, pinned: true },
    { repository: "org/closed", account: "novan-xu", chosen: false, pinned: false },
  ]} tickets={[running, pending]} topics={[]} waiting={{ ...initialWaiting, cards: [startCard(2, { ticket: pending })] }} selected="org/waiting" select={() => undefined} order={async () => true} pin={async () => true} />);
  expect(html.indexOf(text("workbench.all"))).toBeLessThan(html.indexOf(text("conversation.daily")));
  expect(html.indexOf(text("conversation.daily"))).toBeLessThan(html.indexOf("org/legacy"));
  expect(html.indexOf("org/legacy")).toBeLessThan(html.indexOf("org/running"));
  expect(html.indexOf("org/running")).toBeLessThan(html.indexOf("org/waiting"));
  expect(html).not.toContain("org/closed");
  expect(html).toContain(`aria-label="${text("workbench.mark.waits")}"`);
  expect(html).toContain(`aria-label="${text("workbench.mark.runs")}"`);
  expect(html).toContain('class="count">1</span>');
  expect(html.match(/wb-tab-close/g)).toHaveLength(3);
});
