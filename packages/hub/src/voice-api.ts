import type { IncomingMessage } from "node:http";
import { VoiceConfirmation, VoiceOffer, VoiceToolCall, voicePath } from "@super-agent2/protocol";
import { isJson, parseJson, readBody } from "./http-json.js";
import type { VoiceService } from "./voice.js";

const callRoute = /^\/api\/voice\/([a-f0-9-]{36})\/(tool|confirm|end)$/;

export async function voiceRequest(service: VoiceService | undefined, owner: string, method: string, path: string, request: IncomingMessage) {
  if (path === voicePath && method === "GET") {
    return { status: 200, body: { enabled: service?.enabled === true } };
  }
  const match = callRoute.exec(path);
  const id = match?.[1];
  if (method !== "POST" || service === undefined || (path !== `${voicePath}/session` && id === undefined)) {
    request.resume();
    return { status: 404, body: { error: "not_found" } };
  }
  if (!isJson(request)) {
    request.resume();
    return { status: 415, body: { error: "unsupported_media_type" } };
  }
  const body = await readBody(request, match?.[2] === "confirm" ? 3_200_000 : 128_000);
  if (path === `${voicePath}/session`) {
    const offer = parseJson(body, VoiceOffer);
    if (offer !== undefined) return service.open(owner, offer);
  } else if (id !== undefined) {
    if (match?.[2] === "tool") {
      const tool = parseJson(body, VoiceToolCall);
      if (tool !== undefined) return service.tool(owner, id, tool);
    } else if (match?.[2] === "confirm") {
      const confirmation = parseJson(body, VoiceConfirmation);
      if (confirmation !== undefined) return service.confirm(owner, id, confirmation);
    } else {
      return service.end(owner, id);
    }
  }
  return { status: 400, body: { error: "bad_request" } };
}
