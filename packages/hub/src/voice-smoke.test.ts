import { expect, it, vi } from "vitest";
import { smokeError, voiceSmokeMain } from "./voice-smoke.js";

it("never prints a key, client secret, or unchecked provider error", async () => {
  const key = "sk-fake-openai-key-1122";
  const clientSecret = "ek-fake-client-secret-1122";
  const print = vi.fn();
  const run = vi.fn().mockRejectedValue(new Error(`Authorization: Bearer ${key}. Secret: ${clientSecret}.`));
  expect(await voiceSmokeMain({ OPENAI_API_KEY: key }, print, run)).toBe(1);
  expect(run).toHaveBeenCalledWith(key, undefined);
  expect(print.mock.calls).toEqual([["FAIL: OpenAI Live smoke test failed."]]);
  expect(smokeError(clientSecret).message).toBe("OpenAI rejected a Live event.");
  run.mockRejectedValue(smokeError("responses_validation_failed"));
  expect(await voiceSmokeMain({ OPENAI_API_KEY: key }, print, run)).toBe(1);
  expect(print.mock.lastCall).toEqual(["FAIL: OpenAI rejected the Responses delegation configuration."]);
  run.mockResolvedValue(undefined);
  expect(await voiceSmokeMain({ OPENAI_API_KEY: key }, print, run)).toBe(0);
  expect(print.mock.lastCall).toEqual(["PASS: OpenAI Live delegated read-only tool round trip."]);
});
