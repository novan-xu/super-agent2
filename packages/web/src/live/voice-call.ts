import { liveFunctionOutput, liveFunctions, type TopicScope } from "@super-agent2/protocol";
import { z } from "zod";
import { voiceApi } from "../hub/api.js";

const TranscriptEvent = z.object({
  type: z.enum(["session.input_transcript.delta", "session.output_transcript.delta"]),
  event_id: z.string(), delta: z.string(), start_ms: z.number(),
});
const SessionEvent = z.object({ type: z.string(), error: z.object({ code: z.string().optional() }).optional() });

export interface VoiceFragment {
  readonly id: string;
  readonly role: "owner" | "assistant";
  readonly text: string;
  readonly start: number;
}

export interface VoiceProposal {
  readonly id: string;
  readonly summary: string;
}

interface VoiceCallbacks {
  readonly started: (id: string) => void;
  readonly transcript: (fragment: VoiceFragment) => void;
  readonly proposal: (proposal: VoiceProposal) => void;
  readonly disconnected: () => void;
  readonly playbackBlocked: () => void;
}

export function voiceLines(fragments: readonly VoiceFragment[]) {
  const lines: { role: VoiceFragment["role"]; text: string }[] = [];
  for (const { role, text } of fragments) {
    const last = lines.at(-1);
    if (last?.role === role) last.text += text;
    else lines.push({ role, text });
  }
  return lines;
}

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const ready = () => {
      if (peer.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    };
    const cancel = () => {
      cleanup();
      reject(stop.reason);
    };
    const cleanup = () => {
      peer.removeEventListener("icegatheringstatechange", ready);
      stop.removeEventListener("abort", cancel);
    };
    peer.addEventListener("icegatheringstatechange", ready);
    stop.addEventListener("abort", cancel);
    if (stop.aborted) cancel();
    else ready();
  });
}

export async function connectVoice(scope: TopicScope, audio: HTMLAudioElement, signal: AbortSignal, callbacks: VoiceCallbacks, context?: string) {
  if (typeof RTCPeerConnection !== "function") throw new Error("WebRTC is unavailable.");
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (signal.aborted) {
    microphone.getTracks().forEach((track) => track.stop());
    signal.throwIfAborted();
  }
  let peer: RTCPeerConnection | undefined;
  let events: RTCDataChannel;
  try {
    peer = new RTCPeerConnection();
    events = peer.createDataChannel("oai-events");
  } catch (error) {
    peer?.close();
    microphone.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const rtc = peer;
  const receiveFunctions = liveFunctions();
  let session: string | undefined;
  let cleaned = false;
  const deadline = setTimeout(() => lost(), 30_000);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(deadline);
    signal.removeEventListener("abort", cleanup);
    const closePeer = () => {
      events.close();
      rtc.close();
    };
    if (events.readyState === "open" && rtc.connectionState === "connected") {
      const timer = setTimeout(closePeer, 1_500);
      events.addEventListener("close", () => {
        clearTimeout(timer);
        rtc.close();
      }, { once: true });
      try {
        events.send(JSON.stringify({ type: "session.close" }));
      } catch {
        clearTimeout(timer);
        closePeer();
      }
    } else {
      closePeer();
    }
    audio.srcObject = null;
    microphone.getTracks().forEach((track) => track.stop());
    if (session !== undefined) void voiceApi.end(session);
  };
  const lost = () => {
    if (cleaned) return;
    cleanup();
    callbacks.disconnected();
  };
  const send = (event: unknown) => {
    if (!cleaned && events.readyState === "open") events.send(JSON.stringify(event));
  };

  const onMessage = async ({ data }: MessageEvent) => {
    if (cleaned || typeof data !== "string" || session === undefined) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    const event = SessionEvent.safeParse(value);
    if (!event.success) return;
    if (event.data.type === "session.started") {
      clearTimeout(deadline);
      callbacks.started(session);
    } else if (event.data.type === "session.closed" || event.data.error?.code === "responses_validation_failed") {
      lost();
    } else {
      const fragment = TranscriptEvent.safeParse(value);
      if (fragment.success) {
        const { event_id: id, type, delta, start_ms: start } = fragment.data;
        callbacks.transcript({ id, role: type === "session.input_transcript.delta" ? "owner" : "assistant", start, text: delta });
      }
      const calls = receiveFunctions(value);
      if (calls === undefined) return;
      for (const call of calls) {
        if (cleaned) return;
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          send(liveFunctionOutput(call, JSON.stringify({ error: "Invalid tool arguments." })));
          continue;
        }
        const result = await voiceApi.tool(session, { name: call.name, arguments: args }, signal);
        if (cleaned) return;
        if (result.ok && result.value.proposal !== undefined) callbacks.proposal(result.value.proposal);
        send(liveFunctionOutput(call, result.ok ? result.value.output : JSON.stringify({ error: "The hub rejected the tool request." })));
      }
      send({ type: "response.create" });
    }
  };

  signal.addEventListener("abort", cleanup, { once: true });
  try {
    rtc.addEventListener("connectionstatechange", () => {
      if (rtc.connectionState === "failed" || rtc.connectionState === "closed") lost();
    });
    rtc.addEventListener("track", ({ track }) => {
      audio.srcObject = new MediaStream([track]);
      void audio.play().catch(() => { if (!cleaned) callbacks.playbackBlocked(); });
    });
    events.addEventListener("message", (event) => void onMessage(event).catch(lost));
    events.addEventListener("close", lost);
    events.addEventListener("error", lost);
    microphone.getAudioTracks().forEach((track) => rtc.addTrack(track, microphone));
    await rtc.setLocalDescription(await rtc.createOffer());
    await waitForIce(rtc, signal);
    const sdp = rtc.localDescription?.sdp;
    if (cleaned || !sdp) throw new Error("Voice offer unavailable.");
    const opened = await voiceApi.open({ sdp, scope, context }, signal);
    if (!opened.ok) throw new Error("Voice connection failed.");
    session = opened.value.id;
    if (cleaned) {
      void voiceApi.end(session);
      throw new Error("Voice connection closed.");
    }
    await rtc.setRemoteDescription({ type: "answer", sdp: opened.value.sdp });
    return { mute: (muted: boolean) => {
      for (const track of microphone.getAudioTracks()) track.enabled = !muted;
    } };
  } catch (error) {
    cleanup();
    throw error;
  }
}
