import { describe, expect, it } from "vitest";
import { ChainStart, DeploymentFile, OwnerMessage, StuckAnswerRequest, TaskAssignment, TaskMaterial, WorkerMessage } from "./index.js";

const long = "长".repeat(500_000);

describe("what the owner, the brain and a worker send", () => {
  it("has no upper limit on its length or number", () => {
    expect(OwnerMessage.safeParse({ text: long }).success).toBe(true);
    expect(WorkerMessage.safeParse({ text: long }).success).toBe(true);
    expect(StuckAnswerRequest.safeParse({ at: 1, answer: "resume", words: long }).success).toBe(true);
    expect(DeploymentFile.safeParse({ target: "box", deploy: long, health: { command: long }, rollback: long }).success).toBe(true);
    expect(ChainStart.safeParse({ chains: Array.from({ length: 500 }, (_, index) => ({ ticket: index + 1, fingerprint: "a".repeat(64) })) }).success).toBe(true);
    const materials = Array.from({ length: 50 }, (_, index) => ({ name: `piece-${index}.txt`, source: "x".repeat(5_000), text: long }));
    expect(TaskMaterial.array().safeParse(materials).success).toBe(true);
    expect(
      TaskAssignment.safeParse({ ticket: 1, attempt: 1, title: "t", task: long, materials, engine: "antigravity", model: "m", effort: "high", session: null, note: null }).success,
    ).toBe(true);
  });

  it("still refuses what is empty", () => {
    expect(OwnerMessage.safeParse({ text: "  " }).success).toBe(false);
    expect(WorkerMessage.safeParse({ text: "" }).success).toBe(false);
  });
});
