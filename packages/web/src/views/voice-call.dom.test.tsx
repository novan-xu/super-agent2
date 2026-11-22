import { text } from "@super-agent2/catalog";
import type { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { voiceApi } from "../hub/api.js";
import { connectVoice } from "../live/voice-call.js";
import { VoiceCall } from "./VoiceCall.js";

vi.mock("../live/voice-call.js", async (original) => ({
  ...await original<typeof import("../live/voice-call.js")>(),
  connectVoice: vi.fn(),
}));

const scope = { kind: "daily" } as const;
const proposal = { id: "proposal", summary: "Check the mobile layout." };
const mute = vi.fn();
const connect = vi.mocked(connectVoice);
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as HappyWindow).happyDOM.setViewport({ width: 375, height: 667 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  connect.mockReset().mockResolvedValue({ mute });
  mute.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (enabled: boolean) => {
  vi.spyOn(voiceApi, "status").mockResolvedValue({ ok: true, value: { enabled } });
  return act(async () => root.render(<VoiceCall scope={scope} />));
};

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") ?? node.textContent) === label)!;
const click = (node: HTMLButtonElement) => act(async () => node.click());
const modal = () => host.querySelector("dialog")!;
const status = () => modal().querySelector('[role="status"]')?.textContent;
const callbacks = () => connect.mock.lastCall![3];

it("keeps the composer call button disabled with a localized hint when no key is configured", async () => {
  await render(false);
  const trigger = button(text("voice.call"));
  expect(trigger.disabled).toBe(true);
  expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe(text("voice.noKey"));
  expect(modal().open).toBe(false);
  expect(connect).not.toHaveBeenCalled();
});

it("shows each active call phase, orders transcript fragments and waits for confirmation before sending", async () => {
  const send = vi.spyOn(voiceApi, "confirm").mockResolvedValue({ ok: false, error: "conflict", reason: "already_sent" });
  await render(true);
  const trigger = button(text("voice.call"));
  expect(trigger.disabled).toBe(false);
  expect(modal().open).toBe(false);
  expect(status()).toBe(text("voice.phase.idle"));
  await click(trigger);
  expect(modal().open).toBe(true);
  expect(status()).toBe(text("voice.phase.connecting"));
  const session = callbacks();
  await act(async () => session.started("call"));
  expect(status()).toBe(text("voice.phase.active"));
  await click(button(text("voice.mute")));
  expect(mute).toHaveBeenCalledWith(true);
  await click(button(text("voice.unmute")));
  expect(mute).toHaveBeenLastCalledWith(false);

  await act(async () => {
    session.transcript({ id: "two", role: "assistant", text: "I will check.", start: 10 });
    session.transcript({ id: "one", role: "owner", text: "Mobile layout.", start: 2 });
    session.transcript({ id: "one", role: "owner", text: "Mobile layout.", start: 2 });
    session.proposal(proposal);
  });
  expect(status()).toBe(text("voice.phase.confirming"));
  expect([...modal().querySelectorAll('[role="log"] p span')].map((el) => el.textContent)).toEqual(["Mobile layout.", "I will check."]);
  expect(modal().textContent).toContain(proposal.summary);
  expect(send).not.toHaveBeenCalled();
  await click(button(text("voice.confirm")));
  expect(send).toHaveBeenCalledExactlyOnceWith("call", {
    proposal: proposal.id, transcript: "你：Mobile layout.\n\nGPT-Live：I will check.",
  });
  expect(status()).toBe(text("voice.phase.sent"));
  expect(connect.mock.lastCall![2].aborted).toBe(true);
  await click(button(text("voice.close")));
  expect(modal().open).toBe(false);
});

it("preserves the transcript across a disconnect and sends nothing when the replacement call is hung up", async () => {
  const send = vi.spyOn(voiceApi, "confirm");
  await render(true);
  await click(button(text("voice.call")));
  await act(async () => {
    callbacks().started("first");
    callbacks().transcript({ id: "one", role: "owner", text: "First segment.", start: 20 });
    callbacks().proposal(proposal);
    callbacks().disconnected();
  });
  expect(status()).toBe(text("voice.phase.disconnected"));
  expect(modal().textContent).toContain("First segment.");
  expect(button(text("voice.confirm"))).toBeUndefined();
  await click(button(text("voice.reconnect")));
  expect(status()).toBe(text("voice.phase.connecting"));
  expect(connect.mock.lastCall?.[4]).toBe("你：First segment.");
  await act(async () => {
    callbacks().started("second");
    callbacks().transcript({ id: "one", role: "assistant", text: "Next segment.", start: 0 });
  });
  expect([...modal().querySelectorAll('[role="log"] p span')].map((el) => el.textContent)).toEqual(["First segment.", "Next segment."]);
  await click(button(text("voice.hangUp")));
  expect(connect.mock.lastCall![2].aborted).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
