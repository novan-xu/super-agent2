import { text } from "@super-agent2/catalog";
import { hasChinese, isBlank, sharedMemoryLimit, type Memory, type MemoryScope } from "@super-agent2/protocol";
import { type FormEvent, type KeyboardEvent, memo, useState } from "react";
import { canSave, type MemoryState, type SuggestionView, suggestionView } from "../live/memory.js";
import { Icon } from "../parts/icons.js";
import { sendsOnEnter } from "../parts/keys.js";
import { momentOf } from "./TicketParts.js";

export type SuggestionDecision = "confirm" | "decline";

export interface MemoryActions {
  readonly add: (text: string, scope?: MemoryScope) => Promise<boolean>;
  readonly edit: (id: number, text: string, scope?: MemoryScope) => Promise<boolean>;
  readonly remove: (id: number) => Promise<boolean>;
  readonly decide: (id: number, decision: SuggestionDecision, scope?: MemoryScope) => Promise<boolean>;
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
  readonly save: MemoryActions["add"];
  readonly scope?: MemoryScope | undefined;
  readonly done: () => void;
}

function ShareControl({ scope, change }: { readonly scope: MemoryScope; readonly change: (next: MemoryScope) => void }) {
  return <label className="memory-sharing"><input type="checkbox" checked={scope === "general"} onChange={(event) => change(event.target.checked ? "general" : "local")} />{text("memory.scope.general")}</label>;
}

function allowsSharing(words: string): boolean {
  return hasChinese(words) && words.trim().length <= sharedMemoryLimit;
}

function Editor({ original, label, save, scope, done }: EditorProps) {
  const [draft, setDraft] = useState(original);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState(scope ?? "local");
  const chosen = scope === undefined ? undefined : selected;
  const ready = (canSave(draft, original) || (!isBlank(draft) && chosen !== scope))
    && (chosen !== "general" || allowsSharing(draft));
  const send = async () => {
    if (!ready || sending) {
      return;
    }
    setSending(true);
    if (await save(draft, chosen)) {
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
      {scope === undefined ? null : <ShareControl scope={selected} change={setSelected} />}
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
  readonly sharing: boolean;
  readonly actions: MemoryActions;
  readonly now: number;
}

const MemoryRow = memo(function MemoryRow({ memory, sharing, actions, now }: RowProps) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const idle = () => setStep({ kind: "idle" });
  if (step.kind === "editing") {
    return (
      <div className="mrow mrow--editing" role="listitem">
        <Editor original={memory.text} label={text("memory.text")} scope={sharing && memory.origin === undefined ? memory.scope ?? "local" : undefined}
          save={(words, scope) => actions.edit(memory.id, words, scope)} done={idle} />
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
          <span className="chip">{memory.origin === undefined ? text(`memory.by.${memory.by}`) : text("memory.origin", { peer: memory.origin })}</span>
          {sharing && memory.origin === undefined ? <span>{text(`memory.scope.${memory.scope ?? "local"}`)}</span> : null}
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
  readonly sharing: boolean;
  readonly decide: MemoryActions["decide"];
  readonly now: number;
}

const SuggestionRow = memo(function SuggestionRow({ view, sharing, decide, now }: SuggestionRowProps) {
  const [sending, setSending] = useState<SuggestionDecision | null>(null);
  const { suggestion, struck } = view;
  const [scope, setScope] = useState<MemoryScope>(suggestion.scope ?? "local");
  const canShare = sharing && suggestion.origin === undefined && suggestion.kind === "remember" && allowsSharing(suggestion.text);
  const confirmsShared = canShare && scope === "general";
  const confirmLabel = suggestion.kind === "principle" ? "memory.confirmSend" : confirmsShared ? "memory.confirmShare" : "memory.confirm";
  const press = (decision: SuggestionDecision) => {
    if (sending !== null) {
      return;
    }
    setSending(decision);
    void decide(suggestion.id, decision, decision === "confirm" && canShare ? scope : undefined).then((decided) => {
      if (!decided) {
        setSending(null);
      }
    });
  };
  return (
    <div className="mrow" role="listitem">
      <div className="mrow-main">
        {suggestion.kind !== "forget" ? <p className="mrow-text">{suggestion.text}</p> : null}
        {struck.length === 0 ? null : (
          <div className="mrow-replaces">
            <span>{text(suggestion.kind === "remember" ? "memory.replaces" : "memory.forgets")}</span>
            {struck.map((old, index) => (
              <s key={index}>{old}</s>
            ))}
          </div>
        )}
        <div className="mrow-meta">
          {suggestion.origin === undefined ? null : <span className="chip">{text("memory.origin", { peer: suggestion.origin })}</span>}
          {suggestion.kind === "principle" ? <span className="chip">{text("memory.principle")}</span> : null}
          <span className="num">{momentOf(suggestion.createdAt, now)}</span>
        </div>
        {canShare ? <ShareControl scope={scope} change={setScope} /> : null}
      </div>
      <div className="mrow-actions">
        <button className={`btn btn-primary btn-sm${sending === "confirm" ? " is-busy" : ""}`} type="button" disabled={sending !== null} aria-busy={sending === "confirm"} onClick={() => press("confirm")}>
          {text(confirmLabel)}
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
          <Editor original="" label={text("memory.new")} scope={memory.sharing ? "local" : undefined} save={actions.add} done={closeAdding} />
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
              <SuggestionRow key={view.suggestion.id} view={view} sharing={memory.sharing === true} decide={actions.decide} now={now} />
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
              <MemoryRow key={item.id} memory={item} sharing={memory.sharing === true} actions={actions} now={now} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
