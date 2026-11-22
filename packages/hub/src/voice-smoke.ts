import { liveFunctionOutput, liveFunctions } from "@super-agent2/protocol";
import WebSocket from "ws";
import { z } from "zod";
import { liveSession, liveSessionsUrl } from "./live-session.js";

const SmokeEvent = z.object({
  type: z.string(),
  error: z.object({ code: z.string().optional() }).optional(),
  event: z.object({ type: z.string(), delta: z.string().optional() }).optional(),
});

const errorDescriptions: Readonly<Record<string, string>> = {
  responses_validation_failed: "OpenAI rejected the Responses delegation configuration.",
  invalid_request_error: "OpenAI rejected the Live request.",
  unsupported_value: "OpenAI rejected a Live session setting.",
  model_not_found: "OpenAI could not access the configured model.",
  function_call_outputs_required: "OpenAI did not receive the expected function output.",
  tool_outputs_required: "OpenAI did not receive the expected tool output.",
  rate_limit_exceeded: "OpenAI rate limited the Live session.",
};

const sentinel = "superagent-voice-smoke/example";

class SmokeFailure extends Error {}

export function smokeError(code: string | undefined) {
  return new SmokeFailure(code !== undefined && Object.hasOwn(errorDescriptions, code)
    ? errorDescriptions[code] ?? "OpenAI rejected a Live event."
    : "OpenAI rejected a Live event.");
}

export function runVoiceSmoke(key: string, model?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(liveSessionsUrl.replace(/^https:/, "wss:"), {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 12_000,
    });
    const functions = liveFunctions();
    let answered = false;
    let reply = "";
    let finishing = false;
    let settled = false;
    const send = (event: object) => socket.send(JSON.stringify(event));
    const close = (problem?: string | SmokeFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (problem !== undefined) {
        reject(typeof problem === "string" ? new SmokeFailure(problem) : problem);
        socket.terminate();
      } else {
        resolve();
        socket.close();
      }
    };
    const timer = setTimeout(() => close("Timed out waiting for the OpenAI Live tool round trip."), 35_000);

    socket.on("unexpected-response", (_, response) => {
      response.resume();
      close(`OpenAI Live WebSocket returned HTTP ${response.statusCode ?? 0}.`);
    });
    socket.on("error", () => close("OpenAI Live WebSocket connection failed."));
    socket.on("close", () => close("OpenAI closed the Live WebSocket before the tool round trip finished."));
    socket.on("open", () => send({
      type: "session.start",
      session: { ...liveSession(model), audio: { format: { type: "audio/pcm", rate: 24_000 } } },
    }));
    socket.on("message", (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        close("OpenAI returned invalid Live event data.");
        return;
      }
      const parsed = SmokeEvent.safeParse(value);
      if (!parsed.success) return;
      const { type, error, event } = parsed.data;
      if (type === "error") {
        close(smokeError(error?.code));
      } else if (type === "session.started") {
        send({ type: "response.item.create", item: { type: "message", role: "user", content: [{
          type: "input_text", text: "For a connectivity check, call list_repositories exactly once and reply with the exact value of the repository field returned by that tool.",
        }] } });
        send({ type: "response.create" });
      } else if (type === "session.closed") {
        close(finishing ? undefined : "OpenAI ended the session before the tool round trip finished.");
      } else if (type === "response.event") {
        const calls = functions(value);
        if (calls !== undefined) {
          if (answered || calls.length !== 1 || calls[0]?.name !== "list_repositories") {
            close("OpenAI requested an unexpected tool in the smoke session.");
            return;
          }
          answered = true;
          reply = "";
          send(liveFunctionOutput(calls[0], JSON.stringify([{ repository: sentinel }])));
          send({ type: "response.create" });
        } else if (event?.type === "response.output_text.delta" && event.delta !== undefined) {
          reply += event.delta;
        } else if (event?.type === "response.completed" && answered && reply.includes(sentinel)) {
          finishing = true;
          send({ type: "session.close" });
        } else if (event?.type === "response.completed" || event?.type === "response.failed" || event?.type === "response.incomplete") {
          close("OpenAI did not complete the expected read-only function round trip.");
        }
      }
    });
  });
}

export async function voiceSmokeMain(
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void,
  run = runVoiceSmoke,
) {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    print("FAIL: OpenAI Live smoke test requires OPENAI_API_KEY.");
    return 1;
  }
  try {
    await run(key, env.HUB_VOICE_DELEGATION_MODEL?.trim() || undefined);
    print("PASS: OpenAI Live delegated read-only tool round trip.");
    return 0;
  } catch (error) {
    const message = error instanceof SmokeFailure ? error.message : "OpenAI Live smoke test failed.";
    print(`FAIL: ${message}`.replaceAll(key, "[redacted]"));
    return 1;
  }
}
