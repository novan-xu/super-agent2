import { describe, expect, it } from "vitest";
import { initialPushFacts, isIosDevice, offersSwitch, type PushFacts, pushPhase } from "./push.js";

const ready: PushFacts = { ...initialPushFacts, key: "AAAA", supported: true };

describe("pushPhase", () => {
  it("waits to hear from the hub first", () => {
    expect(pushPhase(initialPushFacts)).toBe("checking");
  });

  it("offers nothing when the hub has no keys, whatever the browser can do", () => {
    expect(pushPhase({ ...ready, key: null })).toBe("hidden");
    expect(pushPhase({ ...ready, key: null, supported: false, ios: true })).toBe("hidden");
  });

  it("offers nothing when the browser cannot do push", () => {
    expect(pushPhase({ ...ready, supported: false })).toBe("hidden");
  });

  it("tells an iPhone that has not added the page to its home screen to do that first", () => {
    expect(pushPhase({ ...ready, supported: false, ios: true, standalone: false })).toBe("install");
    expect(pushPhase({ ...ready, supported: false, ios: true, standalone: true })).toBe("hidden");
  });

  it("is off until the owner turns it on, and on once the device is subscribed and allowed", () => {
    expect(pushPhase(ready)).toBe("off");
    expect(pushPhase({ ...ready, permission: "granted" })).toBe("off");
    expect(pushPhase({ ...ready, permission: "granted", subscribed: true })).toBe("on");
  });

  it("is off when a subscription exists but the permission was taken back", () => {
    expect(pushPhase({ ...ready, permission: "default", subscribed: true })).toBe("off");
  });

  it("is blocked when the browser has refused notifications", () => {
    expect(pushPhase({ ...ready, permission: "denied" })).toBe("blocked");
  });

  it("is working while something is being changed", () => {
    expect(pushPhase({ ...ready, working: true })).toBe("working");
  });

  it("offers the switch in exactly the phases where it means something", () => {
    expect(["checking", "hidden", "install", "blocked", "off", "on", "working"].filter((phase) => offersSwitch(phase as never))).toEqual(["blocked", "off", "on", "working"]);
  });
});

describe("isIosDevice", () => {
  it("knows an iPhone, an iPad and an iPad that says it is a Mac", () => {
    expect(isIosDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone", 5)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "iPad", 5)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe(true);
  });

  it("does not take a Mac or a phone of another make for one", () => {
    expect(isIosDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0)).toBe(false);
    expect(isIosDevice("Mozilla/5.0 (Linux; Android 15)", "Linux armv8l", 5)).toBe(false);
  });
});
