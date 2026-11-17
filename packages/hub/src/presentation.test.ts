import { messages, type MessageKey, text } from "@super-agent2/catalog";
import { CommandState, HoldAnswer, Refusal } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { formIds, irreversibleForms } from "./irreversible.js";
import { changedReason, refusedReason, withdrawnReason } from "./lock.js";
import { interruptedReason } from "./commands.js";

function has(key: string): key is MessageKey {
  return Object.hasOwn(messages, key);
}

describe("what the owner is shown", () => {
  it("has a label for every state of a command", () => {
    for (const state of CommandState.options) {
      expect(has(`command.state.${state}`), state).toBe(true);
    }
  });

  it("has a label for every answer to a hold", () => {
    for (const answer of HoldAnswer.options) {
      expect(has(`hold.answer.${answer}`), answer).toBe(true);
    }
  });

  it("has a sentence for every refusal the hub gives", () => {
    for (const error of Refusal.shape.error.options) {
      expect(has(`refusal.${error}`), error).toBe(true);
    }
  });

  it("describes every irreversible form in Chinese", () => {
    expect(irreversibleForms.map((form) => form.id)).toEqual([...formIds]);
    for (const form of irreversibleForms) {
      expect(form.description).toMatch(/\p{Script=Han}/u);
    }
  });

  it("gives every reason of its own in Chinese", () => {
    for (const reason of [refusedReason, withdrawnReason, changedReason, interruptedReason]) {
      expect(reason).toMatch(/\p{Script=Han}/u);
    }
    expect(text("command.reason.noTarget", { target: "x" })).toMatch(/\p{Script=Han}/u);
  });
});
