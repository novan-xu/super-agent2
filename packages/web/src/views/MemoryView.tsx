import { text } from "@super-agent2/catalog";
import type { Memory } from "@super-agent2/protocol";
import { type FormEvent, type KeyboardEvent, memo, useState } from "react";
import { canSave, type MemoryState, type SuggestionView, suggestionView } from "../live/memory.js";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";
import { momentOf } from "./TicketParts.js";

export type SuggestionDecision = "confirm" | "decline";

export interface MemoryActions {
  readonly add: (text: string) => Promise<boolean>;
  readonly edit: (id: number, text: string) => Promise<boolean>;
  readonly remove: (id: number) => Promise<boolean>;
  readonly decide: (id: number, decision: SuggestionDecision) => Promise<boolean>;
}

export interface MemoryViewProps {
  readonly memory: MemoryState;
  readonly actions: MemoryActions;
  readonly adding: boolean;
  readonly closeAdding: () => void;
  readonly now: number;
}

interface EditorProps {
  readonly original: string;
  readonly label: string;
  readonly save: (text: string) => Promise<boolean>;
  readonly done: () => void;
}

function Editor({ original, label, save, done }: EditorProps) {
  const [draft, setDraft] = useState(original);
  const [sending, setSending] = useState(false);
  const ready = canSave(draft, original);
  const send = async () => {
    if (!ready || sending) {
      return;
    }
    setSending(true);
    if (await save(draft)) {
      done();
    } else {
      setSending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done();
      return;
    }
    if (sendsOnEnter(event)) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form className="editor" onSubmit={submit}>
      <textarea className="field" rows={3} value={draft} autoFocus aria-label={label} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} />
      <div className="card-actions">
        <button className={`btn btn-primary btn-sm${sending ? " is-busy" : ""}`} type="submit" disabled={!ready || sending} aria-busy={sending}>
          {text("memory.save")}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={done}>
          {text("memory.cancel")}
        </button>
      </div>
    </form>
  );
}

type Step = { readonly kind: "idle" } | { readonly kind: "editing" } | { readonly kind: "armed"; readonly sending: boolean };

interface RowProps {
  readonly memory: Memory;
  readonly actions: MemoryActions;
  readonly now: number;
}

const MemoryRow = memo(function MemoryRow({ memory, actions, now }: RowProps) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const idle = () => setStep({ kind: "idle" });
  if (step.kind === "editing") {
    return (
      <div className="mrow mrow--editing" role="listitem">
        <Editor original={memory.text} label={text("memory.text")} save={(words) => actions.edit(memory.id, words)} done={idle} />
      </div>
    );
  }
  const remove = () => {
    if (step.kind !== "armed" || step.sending) {
      return;
    }
    setStep({ kind: "armed", sending: true });
    void actions.remove(memory.id).then((removed) => {
      if (!removed) {
        idle();
      }
    });
  };
  return (
    <div className={step.kind === "armed" ? "mrow mrow--armed" : "mrow"} role="listitem">
      <div className="mrow-main">
        <p className="mrow-text">{memory.text}</p>
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
          <button className="icon-btn" type="button" aria-label={text("memory.edit")} title={text("memory.edit")} onClick={() => setStep({ kind: "editing" })}>
            <Icon name="compose" />
          </button>
          <button className="icon-btn" type="button" aria-label={text("memory.delete")} title={text("memory.delete")} onClick={() => setStep({ kind: "armed", sending: false })}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  );
});

interface SuggestionRowProps {
  readonly view: SuggestionView;
  readonly decide: MemoryActions["decide"];
  readonly now: number;
}

const SuggestionRow = memo(function SuggestionRow({ view, decide, now }: SuggestionRowProps) {
  const [sending, setSending] = useState<SuggestionDecision | null>(null);
  const { suggestion, struck } = view;
  const press = (decision: SuggestionDecision) => {
    if (sending !== null) {
      return;
    }
    setSending(decision);
    void decide(suggestion.id, decision).then((decided) => {
      if (!decided) {
        setSending(null);
      }
    });
  };
  return (
    <div className="mrow" role="listitem">
      <div className="mrow-main">
        {suggestion.kind === "remember" ? <p className="mrow-text">{suggestion.text}</p> : null}
        {struck.length === 0 ? null : (
          <div className="mrow-replaces">
            <span>{text(suggestion.kind === "remember" ? "memory.replaces" : "memory.forgets")}</span>
            {struck.map((old, index) => (
              <s key={index}>{old}</s>
            ))}
          </div>
        )}
        <div className="mrow-meta">
          <span className="num">{momentOf(suggestion.createdAt, now)}</span>
        </div>
      </div>
      <div className="mrow-actions">
        <button className={`btn btn-primary btn-sm${sending === "confirm" ? " is-busy" : ""}`} type="button" disabled={sending !== null} aria-busy={sending === "confirm"} onClick={() => press("confirm")}>
          {text("memory.confirm")}
        </button>
        <button className={`btn btn-ghost btn-sm${sending === "decline" ? " is-busy" : ""}`} type="button" disabled={sending !== null} aria-busy={sending === "decline"} onClick={() => press("decline")}>
          {text("memory.decline")}
        </button>
      </div>
    </div>
  );
});

export function MemoryView({ memory, actions, adding, closeAdding, now }: MemoryViewProps) {
  const pending = memory.suggestions.map((suggestion) => suggestionView(suggestion, memory.memories));
  const empty = memory.loaded && !adding && memory.memories.length === 0 && pending.length === 0;
  return (
    <div className="page page--narrow">
      {adding ? (
        <div className="mem-new">
          <Editor original="" label={text("memory.new")} save={actions.add} done={closeAdding} />
        </div>
      ) : null}
      {empty ? (
        <div className="empty">
          <Icon name="memory" />
          <strong>{text("memory.empty")}</strong>
        </div>
      ) : null}
      {pending.length === 0 ? null : (
        <section className="section">
          <div className="section-head">
            <h2 id="memory-pending">{text("memory.pending")}</h2>
            <span className="count count--hot">{pending.length}</span>
          </div>
          <div className="mem-list" role="list" aria-labelledby="memory-pending">
            {pending.map((view) => (
              <SuggestionRow key={view.suggestion.id} view={view} decide={actions.decide} now={now} />
            ))}
          </div>
        </section>
      )}
      {memory.memories.length === 0 ? null : (
        <section className="section">
          <div className="section-head">
            <h2 id="memory-kept">{text("memory.kept")}</h2>
            <span className="count">{memory.memories.length}</span>
          </div>
          <div className="mem-list" role="list" aria-labelledby="memory-kept">
            {memory.memories.map((item) => (
              <MemoryRow key={item.id} memory={item} actions={actions} now={now} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
