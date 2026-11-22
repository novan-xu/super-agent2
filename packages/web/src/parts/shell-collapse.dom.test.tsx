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
  expect(host.querySelectorAll(".side-status-compact [role=img]")).toHaveLength(2);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Shell {...props} />));
  expect(host.querySelector(".app--collapsed")).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".side-toggle")!.click());
  expect(host.querySelector(".app--collapsed")).toBeNull();
  expect(localStorage.getItem("sidebar.collapsed")).toBe("false");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
