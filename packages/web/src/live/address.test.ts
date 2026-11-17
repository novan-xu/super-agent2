import { describe, expect, it } from "vitest";
import { destinationOf, destinationOfMessage } from "./address.js";

const origin = "https://hub.example.com";

describe("destinationOf", () => {
  it("reads the page and the card a notification opens", () => {
    expect(destinationOf("/workbench?card=hold%3Aabc", origin)).toEqual({ route: { view: "workbench" }, card: "hold:abc" });
  });

  it("reads a page without a card", () => {
    expect(destinationOf("/workbench", origin)).toEqual({ route: { view: "workbench" }, card: null });
    expect(destinationOf("/workbench?card=", origin)).toEqual({ route: { view: "workbench" }, card: null });
  });

  it("refuses an address that is not a page of this site", () => {
    expect(destinationOf("/api/commands", origin)).toBeUndefined();
    expect(destinationOf("https://elsewhere.example.com/workbench", origin)).toBeUndefined();
    expect(destinationOf("//elsewhere.example.com/workbench", origin)).toBeUndefined();
  });
});

describe("destinationOfMessage", () => {
  it("reads the message the worker sends", () => {
    expect(destinationOfMessage({ type: "open", url: "/workbench?card=hold%3Aabc" }, origin)).toEqual({ route: { view: "workbench" }, card: "hold:abc" });
  });

  it("ignores any other message", () => {
    for (const data of [null, "open", 3, {}, { type: "other", url: "/workbench" }, { type: "open" }, { type: "open", url: 5 }]) {
      expect(destinationOfMessage(data, origin)).toBeUndefined();
    }
  });
});
