import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCard, ticket, workStatus } from "../live/fixtures.js";
import { initialWaiting } from "../live/waiting.js";
import { CanvasWorkbench, type CanvasWorkbenchProps } from "./CanvasWorkbench.js";

const noop = () => undefined;
const first = ticket(1, { repository: "org/one", state: "working", work: workStatus() });
const second = ticket(2, { repository: "org/one", waits: [{ ticket: 1, deployment: false, waived: false }], waitsFor: [1] });
const props: CanvasWorkbenchProps = {
  tickets: [first, second], pinnedRepositories: [{ repository: "org/one" }], waiting: { ...initialWaiting, known: true },
  actions: { answer: noop, start: noop, choose: noop, answerStuck: noop }, repository: undefined,
  selectRepository: noop, selected: null, selectTicket: noop, ticketHref: (id) => `/tickets/${id}`,
  pane: "canvas", setPane: noop, panel: <div>Conversation</div>, focus: null, focused: noop, push: "hidden", togglePush: noop, rearrange: async () => true, rearranging: false,
};
let host: HTMLDivElement;
let root: Root;
let layoutWidth: number;
let layoutHeight: number;
let gridWidth: number;
let observers: Array<() => void>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  layoutWidth = 1200;
  layoutHeight = 1000;
  gridWidth = 700;
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.push(callback); }
    observe() { this.callback(); }
    disconnect() { observers = observers.filter((callback) => callback !== this.callback); }
  });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("wb-layout") ? layoutWidth : gridWidth;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("wb-layout") ? layoutHeight : 100; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.closest('[data-ticket="2"]') ? gridWidth / 2 : 0;
    const width = this.classList.contains("wb-repos") ? 180 : this.classList.contains("wb-card") ? gridWidth / 2 - 10 : gridWidth;
    return { left, right: left + width, top: 0, bottom: 100, width, height: 100, x: left, y: 0, toJSON: noop };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const splitter = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const width = () => host.querySelector<HTMLElement>(".wb-layout")!.style.getPropertyValue("--wb-panel-width");

async function render() { await act(async () => root.render(<CanvasWorkbench {...props} />)); }

describe("workbench panel resizing", () => {
  it("starts only complete cards in the selected scope and disables while sending", async () => {
    const start = vi.fn();
    const cards = [startCard(1, { ticket: { repository: "org/one" } }), startCard(2, { ticket: { repository: "org/two" } }), startCard(3, { ticket: { repository: null } }), startCard(4, { ticket: { repository: "org/one" }, choice: { missing: ["defaults"] } }), startCard(5, { startable: false })];
    const waiting = { ...initialWaiting, known: true, cards };
    const actions = { ...props.actions, start };
    const button = () => host.querySelector<HTMLButtonElement>(".wb-toolbar .btn-primary");
    await act(async () => root.render(<CanvasWorkbench {...props} waiting={{ ...waiting, cards: [] }} actions={actions} />));
    expect(button()).toBeNull();
    await act(async () => root.render(<CanvasWorkbench {...props} waiting={waiting} actions={actions} />));
    expect(button()?.textContent).toContain("3");
    await act(async () => button()!.click());
    expect(start).toHaveBeenLastCalledWith(["start:1", "start:2", "start:3"]);
    await act(async () => root.render(<CanvasWorkbench {...props} waiting={waiting} actions={actions} repository="ORG/ONE" />));
    expect(button()?.textContent).toContain("1");
    await act(async () => button()!.click());
    expect(start).toHaveBeenLastCalledWith(["start:1"]);
    await act(async () => root.render(<CanvasWorkbench {...props} waiting={waiting} actions={actions} repository={null} />));
    await act(async () => button()!.click());
    expect(start).toHaveBeenLastCalledWith(["start:3"]);
    await act(async () => root.render(<CanvasWorkbench {...props} waiting={{ ...waiting, use: { "start:1": { step: "sending", verdict: null, failure: null } } }} actions={actions} />));
    expect(button()?.disabled).toBe(true);
  });

  it("starts rearrangement and opens the conversation panel after it succeeds", async () => {
    const rearrange = vi.fn().mockResolvedValue(true);
    const setPane = vi.fn();
    await act(async () => root.render(<CanvasWorkbench {...props} rearrange={rearrange} setPane={setPane} />));
    const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "编排")!;
    await act(async () => button.click());
    expect(rearrange).toHaveBeenCalledOnce();
    expect(setPane).toHaveBeenCalledWith("panel");
  });

  it("opens the ticket when a start-card link outlives its card", async () => {
    const selectTicket = vi.fn();
    const selectRepository = vi.fn();
    await act(async () => root.render(<CanvasWorkbench {...props} focus="start:1" selectTicket={selectTicket} selectRepository={selectRepository} />));
    expect(selectTicket).toHaveBeenCalledWith(1);
    expect(selectRepository).toHaveBeenCalledWith("org/one");
  });

  it("opens a linked ticket in all when its repository is archived", async () => {
    const selectTicket = vi.fn();
    const selectRepository = vi.fn();
    await act(async () => root.render(<CanvasWorkbench {...props} pinnedRepositories={[]} focus="start:1" selectTicket={selectTicket} selectRepository={selectRepository} />));
    expect(selectTicket).toHaveBeenCalledWith(1);
    expect(selectRepository).toHaveBeenCalledWith(undefined);
  });

  it("supports pointer and keyboard resizing, persistence, resize clamping and reset", async () => {
    await render();
    expect(width()).toBe("380px");
    splitter().setPointerCapture = vi.fn();
    await act(async () => {
      splitter().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 800 }));
      splitter().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 950 }));
      splitter().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });
    expect(width()).toBe("530px");
    expect(localStorage.getItem("workbench.panelWidth")).toBe("530");
    await act(async () => splitter().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
    expect(splitter().getAttribute("aria-valuenow")).toBe("554");
    layoutWidth = 700;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(width()).toBe("432px");
    layoutWidth = 1200;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(width()).toBe("554px");
    await act(async () => splitter().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(width()).toBe("380px");
    expect(localStorage.getItem("workbench.panelWidth")).toBe("380");
    await act(async () => root.unmount());
    root = createRoot(host);
    localStorage.setItem("workbench.panelWidth", "500");
    await render();
    expect(width()).toBe("500px");
  });

  it("switches orientation live and resizes and remembers the portrait panel independently", async () => {
    let portrait = false;
    let onChange: (() => void) | undefined;
    vi.mocked(window.matchMedia).mockImplementation((query) => query.includes("orientation")
      ? { get matches() { return portrait; }, addEventListener: (_: string, callback: () => void) => { onChange = callback; }, removeEventListener: noop } as unknown as MediaQueryList
      : { matches: false } as MediaQueryList);
    localStorage.setItem("workbench.panelWidth", "500");
    await render();
    expect(host.querySelector(".wb-layout--portrait")).toBeNull();
    portrait = true;
    await act(async () => onChange?.());
    const layout = host.querySelector<HTMLElement>(".wb-layout")!;
    expect(layout.classList.contains("wb-layout--portrait")).toBe(true);
    expect(splitter().getAttribute("aria-orientation")).toBe("horizontal");
    expect(splitter().getAttribute("aria-valuenow")).toBe("496");
    await act(async () => splitter().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })));
    expect(localStorage.getItem("workbench.panelHeight")).toBe("520");
    splitter().setPointerCapture = vi.fn();
    await act(async () => {
      splitter().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientY: 500 }));
      splitter().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 400 }));
      splitter().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });
    expect(localStorage.getItem("workbench.panelHeight")).toBe("620");
    layoutHeight = 700;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(splitter().getAttribute("aria-valuenow")).toBe("492");
    portrait = false;
    await act(async () => onChange?.());
    expect(width()).toBe("500px");
    portrait = true;
    layoutHeight = 1000;
    await act(async () => onChange?.());
    expect(splitter().getAttribute("aria-valuenow")).toBe("620");
    await act(async () => splitter().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(splitter().getAttribute("aria-valuenow")).toBe("496");
    expect(localStorage.getItem("workbench.panelHeight")).toBeNull();
  });

  it("recomputes canvas columns and dependency paths when the grid changes width", async () => {
    await render();
    const grid = host.querySelector<HTMLElement>(".wb-grid")!;
    expect(grid.style.getPropertyValue("--wb-columns")).toBe("3");
    const path = host.querySelector(".wb-links > path")!.getAttribute("d");
    gridWidth = 400;
    await act(async () => { for (const callback of [...observers]) callback(); });
    expect(grid.style.getPropertyValue("--wb-columns")).toBe("1");
    expect(host.querySelector(".wb-links > path")!.getAttribute("d")).not.toBe(path);
  });
});
