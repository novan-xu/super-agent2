import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { startCard } from "../live/fixtures.js";
import { initialWaiting } from "../live/waiting.js";
import { ConversationChains } from "./ConversationChains.js";

it("starts the shown fingerprint and disables a rearranged card", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const start = vi.fn();
  const card = startCard(1);
  if (card.kind !== "start") throw new Error("missing start card");
  const entry = { kind: "chains" as const, id: "e", conversation: "c", seq: 1, at: 1, turn: "t", chains: [{ ticket: 1, fingerprint: card.fingerprint }] };
  const show = async (fingerprint: string) => act(async () => root.render(<ConversationChains entry={entry} tickets={[]} waiting={{ ...initialWaiting, known: true, cards: [{ ...card, fingerprint }] }} start={start} />));
  await show(card.fingerprint);
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(start).toHaveBeenCalledWith(["start:1"], { "start:1": card.fingerprint });
  await show("f".repeat(64));
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(host.textContent).toContain("排列已变");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
