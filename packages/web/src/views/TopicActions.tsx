import { text } from "@super-agent2/catalog";
import type { Conversation } from "@super-agent2/protocol";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../parts/icons.js";

export interface TopicActions {
  rename(source: string, title: string): Promise<boolean>;
  archive(source: string): Promise<boolean>;
  merge(source: string, destination: string): Promise<boolean>;
  move(source: string, message: string, destination: string): Promise<boolean>;
}

export type TopicEdit = { readonly topic: Conversation; readonly message?: never } | { readonly topic?: never; readonly source: string; readonly message: string };

export function titleOf(topic: { readonly title: string } | undefined): string {
  return topic?.title || text("conversation.untitled");
}

type Operation = "rename" | "archive" | "merge" | "move";
const operationText = {
  rename: "conversation.rename",
  archive: "conversation.archive",
  merge: "conversation.merge",
  move: "conversation.move",
} as const;

export function TopicActionButton({ topic, edit }: { readonly topic: Conversation; readonly edit: (topic: TopicEdit) => void }) {
  return (
    <button className="icon-btn topic-actions-button" type="button" aria-haspopup="dialog"
      aria-label={text("conversation.actionsFor", { topic: titleOf(topic) })} onClick={() => edit({ topic })}>
      <Icon name="more" size={16} />
    </button>
  );
}

export function TopicActionDialog({ edit, list, actions, done }: {
  readonly edit: TopicEdit;
  readonly list: readonly Conversation[];
  readonly actions: TopicActions;
  readonly done: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [operation, setOperation] = useState<Operation | null>(edit.message === undefined ? null : "move");
  const [title, setTitle] = useState(edit.topic?.title ?? "");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const source = edit.message === undefined ? edit.topic.id : edit.source;
  const label = operation === null ? titleOf(edit.topic) : text(operationText[operation]);
  const targets = list.filter((topic) => topic.id !== source && topic.mergedInto === undefined && (operation !== "merge" || !topic.mergePending));
  const submit = async () => {
    if (operation === null || busy) {
      return;
    }
    setBusy(true);
    const ok = operation === "rename" ? await actions.rename(source, title)
      : operation === "archive" ? await actions.archive(source)
      : operation === "merge" ? await actions.merge(source, destination)
      : edit.message !== undefined && await actions.move(source, edit.message, destination);
    if (ok) {
      dialog.current?.close();
    } else {
      setBusy(false);
    }
  };
  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog className="dlg topic-action-dialog" ref={dialog} aria-label={label} onClose={done}>
      <div className="dlg-in">
        <div className="dlg-head">
          <h2 className="od-truncate">{label}</h2>
          <button className="icon-btn" type="button" aria-label={text("conversation.close")} onClick={() => dialog.current?.close()}>
            <Icon name="x" />
          </button>
        </div>
        {operation === null ? (
          <div className="topic-action-options">
            <button className="btn" type="button" onClick={() => setOperation("rename")}>{text("conversation.rename")}</button>
            {edit.topic?.system || edit.topic?.mergePending ? null : (
              <button className="btn" type="button" onClick={() => setOperation("merge")}>{text("conversation.merge")}</button>
            )}
            {edit.topic?.topicState === "archived" ? null : (
              <button className="btn" type="button" onClick={() => setOperation("archive")}>{text("conversation.archive")}</button>
            )}
          </div>
        ) : (
          <form className="topic-action-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {operation === "rename" ? (
              <input className="field" aria-label={text("conversation.topicName")} value={title} maxLength={120}
                required onChange={(event) => setTitle(event.target.value)} />
            ) : operation === "archive" ? <p className="dlg-text">{titleOf(edit.topic)}</p> : (
              <select className="field" aria-label={text("conversation.destination")} value={destination} required
                onChange={(event) => setDestination(event.target.value)}>
                <option value="">{text("conversation.chooseDestination")}</option>
                {targets.map((topic) => <option key={topic.id} value={topic.id}>
                  {topic.repository === null ? titleOf(topic) : `${titleOf(topic)} · ${topic.repository}`}
                </option>)}
              </select>
            )}
            <div className="dlg-actions">
              <button className="btn btn-primary" type="submit" disabled={busy}>{text(operationText[operation])}</button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
