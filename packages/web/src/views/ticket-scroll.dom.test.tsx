import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDetail, receiveDetail, receiveDetailWork } from "../live/detail.js";
import { ticket, workEvent } from "../live/fixtures.js";
import { TicketView, type TicketActions, type TicketOrigin } from "./TicketView.js";

const actions: TicketActions = {
  stop: async () => true, reassign: async () => true, message: async () => true,
  review: async () => true, machines: async () => [],
};
let host: HTMLDivElement;
let scroller: HTMLDivElement;
let root: Root;
let height: number;
let position: number;
let resize: () => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  host = document.createElement("div");
  scroller = document.createElement("div");
  scroller.id = "main";
  document.body.append(scroller);
  scroller.append(host);
  height = 1000;
  position = 0;
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height }, clientHeight: { get: () => 200 },
    scrollTop: { get: () => position, set: (value: number) => { position = Math.max(0, Math.min(value, height - 200)); } },
  });
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  scroller.remove();
  vi.unstubAllGlobals();
});

function detail(id: number, seq = 1) {
  const value = ticket(id);
  return receiveDetailWork(receiveDetail(openDetail(id), { ticket: value, moves: [], attempts: [], rounds: [], switches: [] }), [workEvent(seq, { kind: "text", block: "a", delta: "Latest" })]);
}

async function render(origin: TicketOrigin, id = 1, seq = 1) {
  scroller.className = origin === "workbench" ? "wb-panel" : "";
  await act(async () => root.render(<TicketView detail={detail(id, seq)} known={new Map()} actions={actions} origin={origin} backHref="/" back={() => undefined} ticketHref={() => "/"} openTicket={() => undefined} now={0} />));
}

for (const origin of ["history", "workbench"] as const) {
  describe(`ticket scrolling from ${origin}`, () => {
    it("opens at the latest entry, follows growth, and lets the owner jump between ends", async () => {
      await render(origin);
      const top = host.querySelector<HTMLButtonElement>('[aria-label="回到顶部"]')!;
      const bottom = host.querySelector<HTMLButtonElement>('[aria-label="回到底部"]')!;
      expect(position).toBe(800);
      expect(bottom.getAttribute("aria-disabled")).toBe("true");
      await act(async () => { height = 1200; resize(); });
      expect(position).toBe(1000);
      await act(async () => top.click());
      expect(position).toBe(0);
      expect(top.getAttribute("aria-disabled")).toBe("true");
      await act(async () => { height = 1400; resize(); });
      await render(origin, 1, 2);
      expect(position).toBe(0);
      await act(async () => bottom.click());
      expect(position).toBe(1200);
      await act(async () => { position = 400; scroller.dispatchEvent(new Event("scroll")); height = 1600; resize(); });
      expect(position).toBe(400);
      await act(async () => bottom.click());
      await act(async () => { height = 1800; resize(); });
      expect(position).toBe(1600);
      await render(origin, 2);
      expect(position).toBe(1600);
    });
    it("keeps following when a short ticket grows", async () => {
      height = 150;
      await render(origin);
      await act(async () => { height = 700; resize(); });
      expect(position).toBe(500);
    });
  });
}
