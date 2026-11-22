import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { initialWaiting } from "../live/waiting.js";
import { RepositoryTabs } from "./RepositoryTabs.js";

it("distinguishes clicks from drags and keeps fixed tabs first", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const select = vi.fn();
  const order = vi.fn(async () => true);
  await act(async () => root.render(<RepositoryTabs repositories={[
    { repository: "org/one", account: "novan-xu", chosen: false, pinned: true, pinnedOrder: 1 },
    { repository: "org/two", account: "novan-xu", chosen: false, pinned: true, pinnedOrder: 2 },
  ]} tickets={[]} topics={[]} waiting={initialWaiting} selected={undefined} select={select} pin={async () => true} order={order} />));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>(".wb-tab-select")];
  buttons[2]!.setPointerCapture = vi.fn();
  await act(async () => {
    buttons[2]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 100 }));
    buttons[2]!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 100 }));
    buttons[2]!.click();
  });
  expect(select).toHaveBeenCalledWith("org/one");
  select.mockClear();
  await act(async () => {
    buttons[2]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, button: 0, clientX: 100 }));
    buttons[2]!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 270 }));
  });
  expect([...host.querySelectorAll(".wb-tab-select")].map((button) => button.textContent)).toEqual([buttons[0]!.textContent, buttons[1]!.textContent, "org/two", "org/one"]);
  await act(async () => {
    buttons[2]!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 270 }));
    buttons[2]!.click();
  });
  expect(select).not.toHaveBeenCalled();
  expect(order).toHaveBeenCalledWith(["org/two", "org/one"]);
  order.mockClear();
  await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, altKey: true, key: "ArrowRight" })));
  expect(order).not.toHaveBeenCalled();
  await act(async () => buttons[3]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, altKey: true, key: "ArrowLeft" })));
  expect(order).toHaveBeenCalledWith(["org/two", "org/one"]);
  await act(async () => root.unmount());
  host.remove();
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("starts touch reordering only after a long press", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const order = vi.fn(async () => true);
  await act(async () => root.render(<RepositoryTabs repositories={[
    { repository: "org/one", account: "novan-xu", chosen: false, pinned: true, pinnedOrder: 1 },
    { repository: "org/two", account: "novan-xu", chosen: false, pinned: true, pinnedOrder: 2 },
  ]} tickets={[]} topics={[]} waiting={initialWaiting} selected={undefined} select={() => undefined} pin={async () => true} order={order} />));
  const button = host.querySelectorAll<HTMLButtonElement>(".wb-tab-select")[2]!;
  button.setPointerCapture = vi.fn();
  await act(async () => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 1, clientX: 100 }));
    button.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "touch", pointerId: 1, clientX: 120 }));
    vi.advanceTimersByTime(500);
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 1, clientX: 270 }));
  });
  expect(order).not.toHaveBeenCalled();
  await act(async () => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 2, clientX: 100 }));
    vi.advanceTimersByTime(500);
    button.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "touch", pointerId: 2, clientX: 270 }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 2, clientX: 270 }));
  });
  expect(order).toHaveBeenCalledWith(["org/two", "org/one"]);
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
