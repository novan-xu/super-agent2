import { text } from "@super-agent2/catalog";
import type { Memory } from "@super-agent2/protocol";
import { type FormEvent, type KeyboardEvent, memo, useState } from "react";
import { editLength, editProblem, type MemoryState, shownProblem } from "../live/memory.js";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";
import { momentOf } from "./TicketParts.js";

export interface MemoryActions {
  readonly edit: (id: number, text: string, revision: number) => Promise<boolean>;
  readonly remove: (id: number, revision: number) => Promise<boolean>;
}

export interface MemoryViewProps {
  readonly memory: MemoryState;
  readonly actions: MemoryActions;
  readonly now: number;
}

type Step = { readonly kind: "idle" } | { readonly kind: "editing"; readonly revision: number; readonly sending: boolean } | { readonly kind: "armed"; readonly revision: number; readonly sending: boolean };

interface RowProps {
  readonly memory: Memory;
  readonly all: readonly Memory[];
  readonly actions: MemoryActions;
  readonly now: number;
}

function Editor({ memory, all, actions, revision, sending, done, send }: RowProps & { readonly revision: number; readonly sending: boolean; readonly done: () => void; readonly send: (sending: boolean) => void }) {
  const [draft, setDraft] = useState(memory.text.zh);
  const problem = editProblem(all, memory.id, draft);
  const shown = shownProblem(problem);
  const save = async () => {
    if (problem !== null || sending) {
      return;
    }
    send(true);
    const saved = await actions.edit(memory.id, draft, revision);
    if (saved) {
      done();
    } else {
      send(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done();
      return;
    }
    if (sendsOnEnter(event)) {
      event.preventDefault();
      void save();
    }
  };
  const errorId = `memory-${memory.id}-problem`;
  return (
    <form className="editor" onSubmit={submit}>
      <textarea
        className="field"
        rows={3}
        value={draft}
        maxLength={editLength}
        autoFocus
        aria-label={text("memory.text")}
        aria-invalid={shown === null ? undefined : true}
        aria-describedby={shown === null ? undefined : errorId}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={keyDown}
      />
      {shown === null ? null : (
        <p className="field-err" id={errorId} role="alert">
          {shown === "long" ? text("memory.problem.long", { count: editLength }) : text(`memory.problem.${shown}`)}
        </p>
      )}
      <div className="card-actions">
        <button className={`btn btn-primary btn-sm${sending ? " is-busy" : ""}`} type="submit" disabled={problem !== null || sending} aria-busy={sending}>
          {text("memory.save")}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={done}>
          {text("memory.cancel")}
        </button>
      </div>
    </form>
  );
}

const MemoryRow = memo(function MemoryRow({ memory, all, actions, now }: RowProps) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const idle = () => setStep({ kind: "idle" });
  if (step.kind === "editing") {
    return (
      <div className="mrow mrow--editing" role="listitem">
        <Editor
          memory={memory}
          all={all}
          actions={actions}
          now={now}
          revision={step.revision}
          sending={step.sending}
          done={idle}
          send={(sending) => setStep({ ...step, sending })}
        />
      </div>
    );
  }
  const remove = () => {
    if (step.kind !== "armed" || step.sending) {
      return;
    }
    setStep({ ...step, sending: true });
    void actions.remove(memory.id, step.revision).then((removed) => {
      if (!removed) {
        idle();
      }
    });
  };
  return (
    <div className={step.kind === "armed" ? "mrow mrow--armed" : "mrow"} role="listitem">
      <div className="mrow-main">
        <p className="mrow-text">{memory.text.zh}</p>
        <div className="mrow-meta">
          <span className="chip">{text(`memory.by.${memory.by}`)}</span>
          <span className="num">{momentOf(memory.changedAt, now)}</span>
        </div>
      </div>
      {step.kind === "armed" ? (
        <div className="mrow-actions" key="armed">
          <button className={`btn btn-danger-solid btn-sm${step.sending ? " is-busy" : ""}`} type="button" disabled={step.sending} aria-busy={step.sending} onClick={remove}>
            {text("memory.confirmDelete")}
          </button>
          <button className="btn btn-sm" type="button" autoFocus disabled={step.sending} onClick={idle}>
            {text("memory.cancel")}
          </button>
        </div>
      ) : (
        <div className="mrow-actions" key="idle">
          <button className="icon-btn" type="button" aria-label={text("memory.edit")} title={text("memory.edit")} onClick={() => setStep({ kind: "editing", revision: memory.revision, sending: false })}>
            <Icon name="compose" />
          </button>
          <button className="icon-btn" type="button" aria-label={text("memory.delete")} title={text("memory.delete")} onClick={() => setStep({ kind: "armed", revision: memory.revision, sending: false })}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  );
});

export function MemoryView({ memory, actions, now }: MemoryViewProps) {
  return (
    <div className="page page--narrow">
      {memory.loaded && memory.memories.length === 0 ? (
        <div className="empty">
          <Icon name="memory" />
          <strong>{text("memory.empty")}</strong>
        </div>
      ) : null}
      {memory.memories.length === 0 ? null : (
        <div className="mem-list" role="list" aria-label={text("memory.list")}>
          {memory.memories.map((item) => (
            <MemoryRow key={item.id} memory={item} all={memory.memories} actions={actions} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
