import { text } from "@super-agent2/catalog";
import { pagePath } from "@super-agent2/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Shell, type ShellProps } from "./Shell.js";

it("persists the sidebar toggle and keeps all navigation labelled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const props: ShellProps = {
    route: { view: "workbench" }, navigate: () => undefined,
    destinationOf: (view) => view === "conversations" ? { view, conversation: null } : { view },
    hrefOf: (view) => pagePath(view === "conversations" ? { view, conversation: null } : { view }),
    status: "open", linked: true, model: "test-model", fill: true, toast: null, waiting: 3,
  };
  await act(async () => root.render(<Shell {...props} />));
  expect(host.querySelector(".app--collapsed")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".side-toggle")!.click());
  expect(host.querySelector(".app--collapsed")).not.toBeNull();
  expect(localStorage.getItem("sidebar.collapsed")).toBe("true");
  expect(host.querySelector(".side-toggle")?.getAttribute("aria-label")).toBe(text("navigation.expandSidebar"));
  expect([...host.querySelectorAll(".side .nav-btn")].every((link) => link.hasAttribute("title") && link.hasAttribute("aria-label"))).toBe(true);
  expect(host.querySelector(".side .count--hot")?.textContent).toBe("3");
  const lamps = [...host.querySelectorAll<HTMLElement>(".hub-card .dot")];
  expect(lamps.map((lamp) => [lamp.getAttribute("role"), lamp.tabIndex, lamp.getAttribute("aria-label"), lamp.title])).toEqual([
    ["img", 0, `${text("hub.name")} ${text("hub.online")}`, `${text("hub.name")} ${text("hub.online")}`],
    ["img", 0, `${text("brain.name")} test-model`, `${text("brain.name")} test-model`],
  ]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Shell {...props} />));
  expect(host.querySelector(".app--collapsed")).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".side-toggle")!.click());
  expect(host.querySelector(".app--collapsed")).toBeNull();
  expect(localStorage.getItem("sidebar.collapsed")).toBe("false");
  expect(host.querySelectorAll(".hub-card .dot[role=img], .hub-card .dot[tabindex]")).toHaveLength(0);
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
