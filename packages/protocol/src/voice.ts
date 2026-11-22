import { z } from "zod";
import { TopicScope } from "./conversations.js";

export const voicePath = "/api/voice";
export const voiceTranscriptLimit = 512_000;
export const VoiceStatus = z.object({ enabled: z.boolean() });
export const VoiceOffer = z.strictObject({ sdp: z.string().min(1).max(64_000), scope: TopicScope, context: z.string().max(3_000).optional() });
export const VoiceSession = z.object({ id: z.uuid(), sdp: z.string().min(1) });
export const VoiceToolCall = z.strictObject({ name: z.string().min(1).max(100), arguments: z.unknown() });
export const VoiceToolResult = z.object({ output: z.string(), proposal: z.object({ id: z.uuid(), summary: z.string() }).optional() });
export const VoiceConfirmation = z.strictObject({
  proposal: z.uuid(),
  transcript: z.string().max(voiceTranscriptLimit),
});
export const VoiceEnd = z.object({ closed: z.literal(true) });

export type VoiceOffer = z.infer<typeof VoiceOffer>;
export type VoiceToolCall = z.infer<typeof VoiceToolCall>;
export type VoiceConfirmation = z.infer<typeof VoiceConfirmation>;
