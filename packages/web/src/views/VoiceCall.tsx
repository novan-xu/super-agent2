import { text } from "@super-agent2/catalog";
import { pagePath, voiceTranscriptLimit, type TopicScope } from "@super-agent2/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { voiceApi } from "../hub/api.js";
import { connectVoice, voiceLines, type VoiceFragment, type VoiceProposal } from "../live/voice-call.js";
import { Icon } from "../parts/icons.js";

type Phase = "idle" | "connecting" | "active" | "confirming" | "sent" | "disconnected";

function transcriptOf(fragments: readonly VoiceFragment[]) {
  return voiceLines(fragments).map(({ role, text: line }) => `${text(`voice.speaker.${role}`)}：${line}`).join("\n\n");
}

export function VoiceCall({ scope }: { readonly scope: TopicScope }) {
  const [availability, setAvailability] = useState<"checking" | "enabled" | "disabled" | "unavailable">("checking");
  const [phase, setPhase] = useState<Phase>("idle");
  const [fragments, setFragments] = useState<VoiceFragment[]>([]);
  const [proposal, setProposal] = useState<VoiceProposal>();
  const [muted, setMuted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [sentLink, setSentLink] = useState<string>();
  const titleId = useId();
  const hintId = useId();
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const connection = useRef<Awaited<ReturnType<typeof connectVoice>>>(undefined);
  const call = useRef<AbortController>(undefined);
  const session = useRef<string>(undefined);
  const confirming = useRef(false);

  useEffect(() => {
    let mounted = true;
    void voiceApi.status().then((result) => {
      if (mounted) setAvailability(result.ok ? result.value.enabled ? "enabled" : "disabled" : "unavailable");
    });
    return () => {
      mounted = false;
      call.current?.abort();
    };
  }, []);

  useEffect(() => {
    const box = transcript.current;
    if (box !== null && box.scrollHeight - box.scrollTop - box.clientHeight < 100) box.scrollTop = box.scrollHeight;
  }, [fragments]);

  const start = (resume: boolean) => {
    const player = audio.current;
    if (player === null) return;
    const saved = resume ? fragments : [];
    const offset = (saved.at(-1)?.start ?? -1) + 1;
    const context = resume ? transcriptOf(saved).slice(-3_000) : undefined;
    call.current?.abort();
    const controller = new AbortController();
    call.current = controller;
    session.current = undefined;
    connection.current = undefined;
    setFragments(saved);
    setMuted(false);
    setProposal(undefined);
    setSendFailed(false);
    setSentLink(undefined);
    setPlaybackBlocked(false);
    setPhase("connecting");
    if (dialog.current?.open === false) dialog.current.showModal();
    const current = () => !controller.signal.aborted;
    const disconnected = () => {
      if (!current()) return;
      session.current = undefined;
      setProposal(undefined);
      setPhase((previous) => previous === "sent" ? previous : "disconnected");
    };
    void connectVoice(scope, player, controller.signal, {
      started: (id) => {
        if (!current()) return;
        session.current = id;
        setPhase("active");
      },
      transcript: (fragment) => {
        if (!current()) return;
        const id = `${offset}:${fragment.id}`;
        const start = offset + fragment.start;
        setFragments((current) => current.some((item) => item.id === id) ? current
          : [...current, { ...fragment, id, start }].sort((a, b) => a.start - b.start));
      },
      proposal: (value) => {
        if (!current() || confirming.current) return;
        setProposal(value);
        setSendFailed(false);
        setPhase("confirming");
      },
      disconnected,
      playbackBlocked: () => { if (current()) setPlaybackBlocked(true); },
    }, context).then((result) => {
      if (current()) connection.current = result;
    }).catch(disconnected);
  };

  const close = () => {
    call.current?.abort();
    dialog.current?.close();
    setPhase("idle");
    setFragments([]);
  };

  const confirm = async () => {
    const id = session.current;
    if (id === undefined || proposal === undefined || confirming.current) return;
    const full = transcriptOf(fragments);
    if (full.length > voiceTranscriptLimit) {
      setSendFailed(true);
      return;
    }
    confirming.current = true;
    setSending(true);
    setSendFailed(false);
    try {
      const result = await voiceApi.confirm(id, { proposal: proposal.id, transcript: full });
      if (result.ok || result.reason === "already_sent") {
        if (result.ok) setSentLink(pagePath({ view: "conversations", conversation: result.value.topic.id, entry: result.value.entry.id, scope }));
        setPhase("sent");
        call.current?.abort();
      } else {
        setSendFailed(true);
      }
    } finally {
      setSending(false);
      confirming.current = false;
    }
  };

  const live = phase === "active" || phase === "confirming";
  const hint = availability === "disabled" ? text("voice.noKey") : availability === "unavailable" ? text("voice.unavailable") : undefined;
  return (
    <>
      <span className="voice-control">
        <button className="btn btn-sm" type="button" disabled={availability !== "enabled"} onClick={() => start(false)}
          title={hint} aria-label={text("voice.call")} aria-describedby={hint === undefined ? undefined : hintId}>
          <Icon name="phone" /><span className="voice-label">{text("voice.call")}</span>
        </button>
        {hint === undefined ? null : <span id={hintId} className="voice-hint">{hint}</span>}
      </span>
      <dialog className="dlg voice-dialog" ref={dialog} aria-labelledby={titleId} onCancel={(event) => {
        event.preventDefault();
        if (!confirming.current) close();
      }}>
        <div className="voice-panel">
          <div className="voice-header">
            <Icon name="phone" />
            <h2 id={titleId}>{text("voice.call")}</h2>
            <span role="status">{phase === "idle" ? null : text(`voice.phase.${phase}`)}</span>
          </div>
          <audio ref={audio} />
          <div className="voice-transcript" role={phase === "idle" ? undefined : "log"} aria-live="off" aria-label={text("voice.transcript")} ref={transcript}>
            {voiceLines(fragments).map(({ role, text: line }, index) =>
              <p key={index}><strong>{text(`voice.speaker.${role}`)}</strong><span>{line}</span></p>)}
          </div>
          {phase === "confirming" && proposal !== undefined ? (
            <div className="voice-summary">
              <strong>{text("voice.summary")}</strong>
              <div className="msg-plain">{proposal.summary}</div>
              {sendFailed ? <span role="alert">{text("voice.sendFailed")}</span> : null}
              <button type="button" className="btn btn-primary" disabled={sending} onClick={() => void confirm()}>{text("voice.confirm")}</button>
            </div>
          ) : null}
          <div className="voice-actions">
            {live ? <button className="btn" type="button" aria-pressed={muted} disabled={sending} onClick={() => {
              connection.current?.mute(!muted);
              setMuted(!muted);
            }}>{text(muted ? "voice.unmute" : "voice.mute")}</button> : null}
            {live && playbackBlocked ? <button className="btn" type="button" onClick={() => {
              void audio.current?.play().then(() => setPlaybackBlocked(false)).catch(() => undefined);
            }}>{text("voice.play")}</button> : null}
            {phase === "sent" && sentLink !== undefined ? <a className="btn" href={sentLink}>{text("voice.openMessage")}</a> : null}
            {phase === "disconnected" ? <button className="btn" type="button" disabled={sending} onClick={() => start(true)}>{text("voice.reconnect")}</button> : null}
            <button className="btn" type="button" disabled={sending} onClick={close}>
              {text(live || phase === "connecting" ? "voice.hangUp" : "voice.close")}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
