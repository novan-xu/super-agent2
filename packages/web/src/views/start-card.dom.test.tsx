import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { startCard } from "../live/fixtures.js";
import { initialWaiting, useOf } from "../live/waiting.js";
import { StartCard } from "./StartCard.js";

it("keeps start and abandonment in one row through confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const card = startCard(1);
  if (card.kind !== "start") throw new Error("missing start card");
  const stop = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<StartCard card={card} use={useOf(initialWaiting, card.key)} focused={false} start={() => undefined} choose={() => undefined} stop={stop} />));
  const row = host.querySelector(".start-actions")!;
  const labels = () => [...row.querySelectorAll("button")].map((button) => button.textContent?.trim());
  const abandon = () => [...row.querySelectorAll("button")].find((button) => button.textContent === "放弃")!;
  expect(labels()).toEqual(["放弃", "开始"]);
  await act(async () => abandon().click());
  expect(labels()).toEqual(["放弃", "取消"]);
  expect(stop).not.toHaveBeenCalled();
  await act(async () => abandon().click());
  expect(stop).toHaveBeenCalledWith(1);
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
