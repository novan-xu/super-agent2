import { randomUUID } from "node:crypto";
import type { TopicScope, VoiceConfirmation, VoiceOffer, VoiceToolCall } from "@super-agent2/protocol";
import type { Clock } from "./clock.js";
import type { ConversationService } from "./conversations.js";
import { openLiveWebRtc } from "./live-session.js";
import { parseVoiceTool, voiceRead, type VoiceToolSources } from "./voice-tools.js";

interface Call {
  readonly owner: string;
  readonly scope: TopicScope;
  readonly expires: number;
  proposal?: { readonly id: string; readonly summary: string };
  submitting?: boolean;
  sent?: boolean;
}

const expired = { status: 404, body: { error: "not_found" } };
const invalid = { status: 400, body: { error: "bad_request" } };
const conflict = { status: 409, body: { error: "conflict" } };

export type VoiceService = ReturnType<typeof createVoice>;

export function createVoice(options: VoiceToolSources & {
  readonly clock: Clock;
  readonly conversations: ConversationService;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly liveFetch?: typeof fetch | undefined;
}) {
  const calls = new Map<string, Call>();
  const key = options.apiKey?.trim();
  let opening = 0;
  const now = () => options.clock.now();
  const enabled = key !== undefined && key !== "";
  const lookup = (owner: string, id: string) => {
    const call = calls.get(id);
    return call?.owner === owner && call.expires > now() ? call : undefined;
  };
  return {
    enabled,
    open: async (owner: string, offer: VoiceOffer) => {
      if (!enabled) return { status: 503, body: { error: "unavailable" } };
      for (const [id, call] of calls) if (call.expires <= now()) calls.delete(id);
      if (calls.size + opening >= 32) return { status: 429, body: { error: "rate_limited" } };
      opening += 1;
      try {
        const sdp = await openLiveWebRtc(key, options.model, offer.sdp, offer.context, options.liveFetch);
        const id = randomUUID();
        calls.set(id, { owner, scope: offer.scope, expires: now() + 60 * 60_000 });
        return { status: 201, body: { id, sdp } };
      } catch {
        return { status: 502, body: { error: "unavailable" } };
      } finally {
        opening -= 1;
      }
    },
    tool: async (owner: string, id: string, request: VoiceToolCall) => {
      const call = lookup(owner, id);
      if (call === undefined) return expired;
      if (call.submitting || call.sent) return conflict;
      const tool = parseVoiceTool(request.name, request.arguments);
      if (tool === undefined) return invalid;
      if (tool.name === "submit_summary") {
        const proposal = { id: randomUUID(), summary: tool.args.summary };
        call.proposal = proposal;
        return { status: 200, body: { proposal, output: JSON.stringify({ status: "awaiting_owner_confirmation" }) } };
      }
      try {
        const result = await voiceRead(options, tool);
        if (result === undefined) return { status: 403, body: { error: "forbidden" } };
        const output = JSON.stringify(result);
        return { status: 200, body: { output: enabled && output.includes(key) ? JSON.stringify({ error: "Tool results contained credentials." }) : output } };
      } catch {
        return { status: 502, body: { error: "unavailable" } };
      }
    },
    confirm: async (owner: string, id: string, request: VoiceConfirmation) => {
      const call = lookup(owner, id);
      if (call === undefined) return expired;
      if (call.sent) return { status: 409, body: { error: "conflict", reason: "already_sent" } };
      if (call.submitting || call.proposal?.id !== request.proposal) return conflict;
      call.submitting = true;
      try {
        const sent = await options.conversations.sendOwner({
          id, text: call.proposal.summary, attachments: [], scope: call.scope, voiceTranscript: request.transcript,
        });
        if (!sent.ok) return conflict;
        call.sent = true;
        return { status: 202, body: sent.item };
      } finally {
        call.submitting = false;
      }
    },
    end: (owner: string, id: string) => {
      const call = lookup(owner, id);
      if (call?.sent !== true && call?.submitting !== true && call !== undefined) calls.delete(id);
      return { status: 200, body: { closed: true } };
    },
  };
}
