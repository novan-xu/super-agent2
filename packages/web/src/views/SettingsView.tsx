import { appPath } from "../parts/app-path.js";
import { text } from "@super-agent2/catalog";
import {
  defaultMachineLoadSettings,
  gitHubAccounts,
  type GitHubAccount,
  machineChoices,
  type MachineAdded,
  MachineLoadSettings,
  type MachineRevoked,
  type MachineStatus,
  machineAccessWarning,
  machineSystems,
  type MachineSystem,
  type ModelChoice,
  type PageRoute,
  pagePath,
  programIsConfigured,
  type Provider,
  type SettingsSection,
  type SettingsSnapshot,
  storageFolders,
  type StorageSettings,
  type Ticket,
  withCell,
} from "@super-agent2/protocol";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { type AccentChoice, accentChoices, type Appearance, type ThemeChoice, themeChoices } from "../live/appearance.js";
import { featureEnabled, programForProvider } from "../live/features.js";
import {
  availableNow,
  cellOf,
  firstSection,
  movedEarlier,
  nameProblem,
  onlineCount,
  pairKey,
  pairOptions,
  type PairOption,
  type ProviderRow,
  providerRows,
  settingsGroups,
  slotsOf,
  subscriptionOf,
  workersOut,
  tableRows,
  type TableRow,
  withChoice,
  ticketsRunningOn,
} from "../live/settings.js";
import { Icon, type IconName } from "../parts/icons.js";
import type { Navigate } from "../parts/route.js";
import { followLink } from "../parts/Shell.js";
import { momentOf } from "./TicketParts.js";

export interface SettingsActions {
  readonly addMachine: (name: string, system: MachineSystem) => Promise<MachineAdded | { readonly refused: string } | undefined>;
  readonly revokeMachine: (name: string) => Promise<MachineRevoked | undefined>;
  readonly setMachineStorage: (name: string, storage: StorageSettings) => Promise<boolean>;
  readonly setMachineLoad: (limits: MachineLoadSettings) => Promise<boolean>;
  readonly setOrder: (role: "brain" | "worker", order: readonly Provider[]) => Promise<boolean>;
  readonly setAccount: (repository: string, account: GitHubAccount) => Promise<boolean>;
  readonly setPinned: (repository: string, pinned: boolean) => Promise<boolean>;
  readonly setAlias: (repository: string, alias: string | null) => Promise<boolean>;
  readonly setTable: (table: SettingsSnapshot["table"]) => Promise<"saved" | "unsupported" | "failed">;
  readonly setAppearance: (change: Partial<Appearance>) => void;
}

export interface SettingsViewProps {
  readonly history?: ReactNode;
  readonly section: SettingsSection | null;
  readonly settings: SettingsSnapshot | null;
  readonly tickets: readonly Ticket[];
  readonly appearance: Appearance;
  readonly actions: SettingsActions;
  readonly navigate: Navigate;
  readonly now: number;
}

const sectionIcons: Readonly<Record<SettingsSection, IconName>> = {
  machines: "machine",
  models: "hub",
  repositories: "repo",
  connections: "connect",
  appearance: "sun",
  usage: "hub",
  history: "history",
};

function routeOf(section: SettingsSection | null): PageRoute {
  return section === null ? { view: "settings" } : { view: "settings", section };
}

function MachineStorageFields({ machine, save }: { readonly machine: MachineStatus; readonly save: SettingsActions["setMachineStorage"] }) {
  const [draft, setDraft] = useState<StorageSettings>({});
  const [saving, setSaving] = useState(false);
  const configured = machine.storage ?? {};
  const changed = storageFolders.some((folder) => draft[folder] !== undefined && draft[folder]?.trim() !== (configured[folder] ?? ""));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!changed || saving) return;
    const storage: StorageSettings = {};
    for (const folder of storageFolders) {
      const value = (draft[folder] ?? configured[folder] ?? "").trim();
      if (value !== "") storage[folder] = value;
    }
    setSaving(true);
    try {
      if (await save(machine.name, storage)) setDraft({});
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="machine-storage" onSubmit={(event) => void submit(event)}>
      {storageFolders.map((folder) => {
        const reported = machine.report?.storage?.[folder];
        const id = `${machine.name}-${folder}`;
        return (
          <div className="machine-storage-field" key={folder}>
            <label htmlFor={id}>{text(`machine.storage.${folder}`)}</label>
            <input
              className="field"
              id={id}
              value={draft[folder] ?? configured[folder] ?? ""}
              placeholder={reported?.path}
              onChange={(event) => setDraft({ ...draft, [folder]: event.currentTarget.value })}
              maxLength={4096}
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
              aria-describedby={reported?.problem === undefined ? undefined : `${id}-problem`}
              aria-invalid={reported?.problem === undefined ? undefined : true}
            />
            {reported?.problem === undefined ? null : <p className="field-err" id={`${id}-problem`}>{text(`machine.storage.${reported.problem}`)}</p>}
          </div>
        );
      })}
      {changed ? <button className="btn btn-sm" type="submit" disabled={saving}>{text("machine.storage.save")}</button> : null}
    </form>
  );
}

function MachineCard({ machine, running, revoke, saveStorage, now }: { readonly machine: MachineStatus; readonly running: number; readonly revoke: () => Promise<void>; readonly saveStorage: SettingsActions["setMachineStorage"]; readonly now: number }) {
  const [step, setStep] = useState<"idle" | "armed" | "sending">("idle");
  const slots = slotsOf(machine);
  const system = machine.report === null ? (machine.system ?? null) : machine.report.platform === "darwin" ? "macos" : machine.report.platform === "win32" ? "windows" : null;
  const expiry = machine.accessExpiresAt;
  const load = machine.online ? machine.report?.load : undefined;
  const percentage = (value: number | null) => value === null ? text("machine.loadUnknown") : `${value}%`;
  const programs = (machine.report?.programs ?? []).filter(programIsConfigured);
  const confirm = () => {
    setStep("sending");
    void revoke().finally(() => setStep("idle"));
  };
  return (
    <article className={step === "idle" ? "mcard" : "mcard mcard--armed"}>
      <div className="mcard-head">
        <span className={`dot ${machine.online ? "dot--ok" : "dot--mute"}`} />
        <span className="mcard-name od-fill od-truncate">{machine.name}</span>
        {load?.high ? <span className="chip chip--warn">{text("machine.busy")}</span> : null}
        {system === null ? null : <span className="chip">{text(`machine.system.${system}`)}</span>}
      </div>
      <p className="card-sub">
        {machine.online ? text("machine.online") : machine.lastSeenAt === null ? text("machine.never") : text("machine.seen", { time: momentOf(machine.lastSeenAt, now) })}
      </p>
      {load === undefined ? null : (
        <div className="slot-legend">
          <span>{text("machine.cpuLoad", { value: percentage(load.cpuPercent), own: percentage(load.ownCpuPercent) })}</span>
          <span>{text("machine.gpuLoad", { value: percentage(load.gpuPercent) })}</span>
        </div>
      )}
      {expiry === undefined ? null : (
        <p className={expiry - now <= machineAccessWarning ? "field-err" : "card-sub"}>{expiry <= now ? text("machine.tokenExpired") : text("machine.tokenUntil", { time: momentOf(expiry, now) })}</p>
      )}
      {slots.total === 0 ? null : (
        <div className="slots">
          <div className="slot-bar" aria-hidden="true">
            {Array.from({ length: slots.total }, (_, index) => (
              <i key={index} className={index < slots.running ? "run" : undefined} />
            ))}
          </div>
          <div className="slot-legend">
            <span>{text("machine.running", { count: slots.running })}</span>
            <span>{text("machine.free", { count: load?.high ? 0 : slots.free })}</span>
          </div>
        </div>
      )}
      {programs.length === 0 ? null : (
        <div className="meta-row">
          {programs.map((program) => (
            <span key={program.id} className="chip">
              {text(`engine.${program.id}`)}
            </span>
          ))}
        </div>
      )}
      {programs.filter((program) => program.update?.note != null).map((program) => (
        <p className="card-sub" key={program.id}>{text(`engine.${program.id}`)}: {program.update?.note}</p>
      ))}
      <MachineStorageFields machine={machine} save={saveStorage} />
      {step === "idle" ? (
        <div className="card-actions" key="idle">
          <span className="od-fill" />
          <button className="btn btn-danger btn-sm" type="button" onClick={() => setStep("armed")}>
            {text("machine.revoke")}
          </button>
        </div>
      ) : (
        <>
          {running === 0 ? null : (
            <p className="field-err" role="alert">
              {text("machine.runningTickets", { count: running, name: machine.name })}
            </p>
          )}
          <div className="card-actions" key="armed">
            <span className="od-fill" />
            <button className="btn btn-sm" type="button" autoFocus disabled={step === "sending"} onClick={() => setStep("idle")}>
              {text("machine.cancel")}
            </button>
            <button className={`btn btn-danger-solid btn-sm${step === "sending" ? " is-busy" : ""}`} type="button" disabled={step === "sending"} aria-busy={step === "sending"} onClick={confirm}>
              {text("machine.revoke")}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function AddMachine({ machines, add }: { readonly machines: readonly MachineStatus[]; readonly add: SettingsActions["addMachine"] }) {
  const [name, setName] = useState("");
  const [system, setSystem] = useState<MachineSystem>("windows");
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [added, setAdded] = useState<MachineAdded | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const trimmed = name.trim();
  const problem = nameProblem(trimmed, machines);
  const shown = tried && trimmed !== "" ? problem : null;
  const arrived = added !== null && machines.some((machine) => machine.name === added.name && machine.lastSeenAt !== null);
  useEffect(() => {
    if (arrived) {
      setAdded(null);
    }
  }, [arrived]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem !== null || sending) {
      return;
    }
    setSending(true);
    setAdded(null);
    setRefused(null);
    void add(trimmed, system).then((answer) => {
      setSending(false);
      if (answer !== undefined && "refused" in answer) {
        setRefused(answer.refused);
        return;
      }
      if (answer !== undefined) {
        setAdded(answer);
        setCopied(false);
        setName("");
        setTried(false);
      }
    });
  };
  const copy = () => {
    if (added === null) {
      return;
    }
    void navigator.clipboard?.writeText(added.command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };
  return (
    <section className="section">
      <div className="section-head">
        <h2>{text("machine.add")}</h2>
      </div>
      <form className="card card-pad od-stack add-machine" onSubmit={submit}>
        <div className="mk-row">
          <div className="form-row">
            <label htmlFor="machine-name">{text("machine.name")}</label>
            <input
              className="field mono"
              id="machine-name"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={63}
              value={name}
              aria-invalid={shown === null ? undefined : true}
              aria-describedby={shown === null ? undefined : "machine-name-problem"}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="form-row">
            <span className="label" id="machine-system">
              {text("machine.system")}
            </span>
            <div className="seg" role="group" aria-labelledby="machine-system">
              {machineSystems.map((choice) => (
                <button key={choice} type="button" aria-pressed={system === choice} onClick={() => setSystem(choice)}>
                  {text(`machine.system.${choice}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {shown === null ? null : (
          <p className="field-err" id="machine-name-problem" role="alert">
            {text(`machine.problem.${shown}`)}
          </p>
        )}
        {refused === null ? null : (
          <p className="field-err" role="alert">
            {text("machine.cloudflareRefused", { reason: refused })}
          </p>
        )}
        <div className="card-actions">
          <button className={`btn btn-primary${sending ? " is-busy" : ""}`} type="submit" disabled={sending || trimmed === ""} aria-busy={sending}>
            {text("machine.make")}
          </button>
        </div>
        {added === null ? null : (
          <>
            <div className="cmd">
              <code>{added.command}</code>
              <button className="icon-btn" type="button" aria-label={copied ? text("machine.copied") : text("machine.copy")} title={copied ? text("machine.copied") : text("machine.copy")} onClick={copy}>
                <Icon name={copied ? "check" : "copy"} />
              </button>
            </div>
            <p className="card-sub">{text("machine.runOnce")}</p>
          </>
        )}
      </form>
    </section>
  );
}

const loadColumns = ["machine.loadCpu", "machine.loadGpu", "machine.loadMinutes"] as const;
const loadRows = [
  ["machine.loadPause", ["cpuHigh", "gpuHigh", "highMinutes"]],
  ["machine.loadResume", ["cpuLow", "gpuLow", "lowMinutes"]],
] as const;

function MachineLoadFields({ limits, save }: { readonly limits: MachineLoadSettings; readonly save: SettingsActions["setMachineLoad"] }) {
  const [draft, setDraft] = useState<Partial<Record<keyof MachineLoadSettings, string>>>({});
  const [saving, setSaving] = useState(false);
  const edits = Object.entries(draft);
  const edited = edits.some(([key, value]) => value !== String(limits[key as keyof MachineLoadSettings]));
  const parsed = MachineLoadSettings.safeParse({ ...limits, ...Object.fromEntries(edits.map(([key, value]) => [key, value === "" ? NaN : Number(value)])) });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsed.success || !edited || saving) return;
    setSaving(true);
    try {
      if (await save(parsed.data)) setDraft({});
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="load-settings section" onSubmit={(event) => void submit(event)}>
      <h3>{text("machine.loadThresholds")}</h3>
      <div className="load-fields">
        <span aria-hidden="true" />
        {loadColumns.map((column) => <span key={column}>{text(column)}</span>)}
        {loadRows.map(([label, keys]) => (
          <div className="load-field-row" key={label}>
            <span>{text(label)}</span>
            {keys.map((key, index) => (
              <input className="field" key={key} type="number" inputMode="numeric"
                min={index === 2 ? 1 : 0} max={index === 2 ? 60 : 100}
                aria-label={`${text(label)} · ${text(loadColumns[index]!)}`} value={draft[key] ?? String(limits[key])}
                disabled={saving} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} required />
            ))}
          </div>
        ))}
      </div>
      {edited && !parsed.success ? <p className="field-err" role="status">{text("machine.loadInvalid")}</p> : null}
      <button className="btn btn-sm" type="submit" disabled={!edited || !parsed.success || saving}>{text("machine.loadSave")}</button>
    </form>
  );
}

function MachinesSection({ settings, tickets, actions, now }: { readonly settings: SettingsSnapshot; readonly tickets: readonly Ticket[]; readonly actions: SettingsActions; readonly now: number }) {
  const [note, setNote] = useState<string | null>(null);
  const revoke = async (name: string) => {
    const answer = await actions.revokeMachine(name);
    if (answer === undefined) {
      return;
    }
    setNote(answer.accessToken === "kept" ? text("machine.revokedKept", { name }) : answer.accessToken === "none" ? text("machine.revokedNone", { name }) : null);
  };
  return (
    <>
      {note === null ? null : (
        <p className="card-sub" role="status">
          {note}
        </p>
      )}
      {settings.machines.length === 0 ? (
        <div className="empty">
          <Icon name="machine" />
          <strong>{text("machine.empty")}</strong>
        </div>
      ) : (
        <div className="machines">
          {settings.machines.map((machine) => (
            <MachineCard key={machine.name} machine={machine} running={ticketsRunningOn(tickets, machine.name)} revoke={() => revoke(machine.name)} saveStorage={actions.setMachineStorage} now={now} />
          ))}
        </div>
      )}
      <MachineLoadFields limits={settings.machineLoad ?? defaultMachineLoadSettings} save={actions.setMachineLoad} />
      {settings.features === undefined || (settings.canAdd.cloudflare && settings.canAdd.release) ? <AddMachine machines={settings.machines} add={actions.addMachine} /> : null}
    </>
  );
}

function ModelPairSelect({ choice, options, label, disabled, change }: { readonly choice: ModelChoice; readonly options: readonly PairOption[]; readonly label: string; readonly disabled?: boolean; readonly change: (choice: ModelChoice) => void }) {
  return (
    <select
      className="field"
      aria-label={label}
      value={pairKey(choice.model, choice.effort)}
      disabled={disabled || options.length < 2}
      onChange={(event) => {
        const option = options.find((item) => pairKey(item.model, item.effort) === event.target.value);
        if (option !== undefined) change({ model: option.model, effort: option.effort });
      }}
    >
      {options.map((option) => (
        <option key={pairKey(option.model, option.effort)} value={pairKey(option.model, option.effort)}>
          {`${option.model} · ${option.effort}`}
        </option>
      ))}
    </select>
  );
}

function TableRowControl({ row, settings, actions, title }: { readonly row: TableRow; readonly settings: SettingsSnapshot; readonly actions: SettingsActions; readonly title: string }) {
  const currentKey = pairKey(row.current.model, row.current.effort);
  const [picked, setPicked] = useState(row.current);
  const [state, setState] = useState<"idle" | "sending" | "unsupported">("idle");
  useEffect(() => {
    setPicked(row.current);
  }, [currentKey]);
  const options = withChoice(pairOptions(machineChoices(settings.machines), row.engine, row.current), picked);
  const chosen = pairKey(picked.model, picked.effort);
  const dirty = chosen !== currentKey;
  const label = text("models.choice", { name: `${text(`engine.${row.engine}`)} ${title}` });
  const save = () => {
    if (!dirty || state === "sending") {
      return;
    }
    setState("sending");
    void actions.setTable(withCell(settings.table, cellOf(row, picked.model, picked.effort))).then((outcome) => setState(outcome === "unsupported" ? "unsupported" : "idle"));
  };
  return (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-title">{title}</span>
      </div>
      <div className="srow-ctl">
        <ModelPairSelect choice={picked} options={options} label={label} change={(choice) => { setPicked(choice); setState("idle"); }} />
        <button className={`btn btn-sm${dirty ? " btn-primary" : ""}${state === "sending" ? " is-busy" : ""}`} type="button" disabled={!dirty || state === "sending"} aria-busy={state === "sending"} onClick={save}>
          {text("models.save")}
        </button>
      </div>
      {state === "unsupported" ? (
        <p className="field-err srow-err" role="alert">
          {text("models.unoffered", { model: picked.model, effort: picked.effort })}
        </p>
      ) : null}
    </div>
  );
}

function AntigravityModels({ settings, actions }: { readonly settings: SettingsSnapshot; readonly actions: SettingsActions }) {
  const current = settings.table.antigravity;
  const currentKey = JSON.stringify(current);
  const [pairs, setPairs] = useState(current);
  const [state, setState] = useState<"idle" | "sending" | "unsupported">("idle");
  useEffect(() => { setPairs(current); }, [currentKey]);
  const options = pairOptions(machineChoices(settings.machines), "antigravity");
  const extra = options.find((option) => !pairs.some((pair) => pair.model === option.model && pair.effort === option.effort));
  const dirty = JSON.stringify(pairs) !== currentKey;
  const sending = state === "sending";
  const update = (next: ModelChoice[]) => { setPairs(next); setState("idle"); };
  const earlier = (index: number) => {
    const previous = pairs[index - 1];
    const pair = pairs[index];
    if (previous !== undefined && pair !== undefined) {
      const next = [...pairs];
      next[index - 1] = pair;
      next[index] = previous;
      update(next);
    }
  };
  const save = async () => {
    setState("sending");
    const outcome = await actions.setTable({ ...settings.table, antigravity: pairs });
    setState(outcome === "unsupported" ? "unsupported" : "idle");
  };
  return (
    <section className="section">
      <div className="section-head"><h2>{text("engine.antigravity")}</h2></div>
      <ol className="rows">
        {pairs.map((pair, index) => (
          <li className="srow" key={index}>
            <div className="srow-ctl srow-ctl--wide model-order">
              <ModelPairSelect choice={pair} options={withChoice(options, pair)} label={text("models.choice", { name: `${text("engine.antigravity")} ${index + 1}` })} disabled={sending} change={(choice) => update(pairs.map((item, position) => position === index ? choice : item))} />
              <button className="icon-btn" type="button" aria-label={text("models.earlier")} title={text("models.earlier")} disabled={sending || index === 0} onClick={() => earlier(index)}><Icon name="up" /></button>
              <button className="icon-btn" type="button" aria-label={text("models.remove")} title={text("models.remove")} disabled={sending || pairs.length === 1} onClick={() => update(pairs.filter((_, position) => position !== index))}><Icon name="x" /></button>
            </div>
          </li>
        ))}
        <li className="srow">
          <div className="srow-ctl">
            <button className="btn btn-sm" type="button" disabled={sending || extra === undefined} onClick={() => { if (extra !== undefined) update([...pairs, { model: extra.model, effort: extra.effort }]); }}><Icon name="plus" />{text("models.add")}</button>
            <button className={`btn btn-sm${dirty ? " btn-primary" : ""}${sending ? " is-busy" : ""}`} type="button" disabled={!dirty || sending} aria-busy={sending} onClick={() => void save()}>{text("models.save")}</button>
          </div>
          {state === "unsupported" ? <p className="field-err srow-err" role="alert">{text("models.unofferedRow")}</p> : null}
        </li>
      </ol>
    </section>
  );
}

function ProviderOrderSection({ title, rows, moving, move }: { readonly title: string; readonly rows: readonly ProviderRow[]; readonly moving: boolean; readonly move: (provider: Provider) => void }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <ol className="rows" aria-label={title}>
        {rows.map((row, index) => (
          <li className="srow" key={row.provider}>
            <span className="order-num num">{index + 1}</span>
            <div className="srow-text">
              <span className="srow-title">{text(`provider.${row.provider}`)}</span>
              {row.state === undefined ? null : <span className="srow-help mono">{`${row.state.model} · ${row.state.effort}`}</span>}
            </div>
            {index > 0 ? (
              <div className="srow-ctl srow-ctl--end">
                <button className="icon-btn" type="button" disabled={moving} aria-label={`${text(`provider.${row.provider}`)} ${text("models.earlier")}`} title={text("models.earlier")} onClick={() => move(row.provider)}>
                  <Icon name="up" />
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ModelsSection({ settings, actions }: { readonly settings: SettingsSnapshot; readonly actions: SettingsActions }) {
  const [moving, setMoving] = useState(false);
  const features = settings.features;
  const workers = providerRows(settings.workerOrder).filter(({ provider }) => features === undefined || features.workerPrograms.includes(programForProvider[provider]));
  const brain = providerRows(settings.brain.order, settings.brain.providers).filter(({ provider }) => features === undefined || features.brainProviders.includes(provider));
  const move = (role: "brain" | "worker", provider: Provider) => {
    if (moving) return;
    const order = role === "brain" ? settings.brain.order : settings.workerOrder;
    const visible = (role === "brain" ? brain : workers).map((row) => row.provider);
    setMoving(true);
    void actions.setOrder(role, movedEarlier(order, provider, visible)).finally(() => setMoving(false));
  };
  return (
    <>
      {workers.length === 0 ? null : <ProviderOrderSection title={text("models.worker")} rows={workers} moving={moving} move={(provider) => move("worker", provider)} />}
      {brain.length === 0 ? null : <ProviderOrderSection title={text("models.brain")} rows={brain} moving={moving} move={(provider) => move("brain", provider)} />}
      {tableRows(settings.table).filter(({ engine }) => features === undefined || features.workerPrograms.includes(engine)).map((group) => (
        <section className="section" key={group.engine}>
          <div className="section-head">
            <h2>{text(`engine.${group.engine}`)}</h2>
          </div>
          <div className="rows">
            {group.rows.map((row) => (
              <TableRowControl key={row.difficulty} row={row} settings={settings} actions={actions} title={text(`ticket.difficulty.${row.difficulty}`)} />
            ))}
          </div>
        </section>
      ))}
      {features === undefined || features.workerPrograms.includes("antigravity") ? <AntigravityModels settings={settings} actions={actions} /> : null}
    </>
  );
}

function RepositoryRow({ row, actions }: { readonly row: SettingsSnapshot["repositories"][number]; readonly actions: SettingsActions }) {
  const [sending, setSending] = useState(false);
  const [alias, setAlias] = useState(row.alias ?? "");
  const cancelled = useRef(false);
  useEffect(() => setAlias(row.alias ?? ""), [row.alias]);
  const saveAlias = () => {
    if (cancelled.current) { cancelled.current = false; return; }
    const value = alias.trim();
    setAlias(value);
    if (value === (row.alias ?? "")) return;
    setSending(true);
    void actions.setAlias(row.repository, value || null).then((ok) => { if (!ok) setAlias(row.alias ?? ""); }).finally(() => setSending(false));
  };
  const save = (update: () => Promise<boolean>) => {
    setSending(true);
    void update().finally(() => setSending(false));
  };
  return (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-title mono od-truncate" title={row.repository}>{row.repository}</span>
        <input className="field repository-alias" aria-label={text("repositories.alias", { repository: row.repository })} placeholder={row.repository.split("/").at(-1)} value={alias} maxLength={40} disabled={sending} onChange={(event) => setAlias(event.target.value)} onBlur={saveAlias} onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") { cancelled.current = true; setAlias(row.alias ?? ""); event.currentTarget.blur(); }
        }} />
      </div>
      <div className="srow-ctl repository-actions">
        <div className="seg" role="group" aria-label={text("repositories.account", { repository: row.repository })}>
          {gitHubAccounts.map((account) => (
            <button key={account} type="button" className="mono" aria-pressed={row.account === account} disabled={sending} onClick={() => {
              if (row.account !== account) save(() => actions.setAccount(row.repository, account));
            }}>
              {account}
            </button>
          ))}
        </div>
        <button type="button" className="btn" disabled={sending}
          aria-label={text(row.pinned ? "repositories.unpinLabel" : "repositories.pinLabel", { repository: row.repository })}
          onClick={() => save(() => actions.setPinned(row.repository, !row.pinned))}>
          {text(row.pinned ? "repositories.unpin" : "repositories.pin")}
        </button>
      </div>
    </div>
  );
}

function RepositoriesSection({ settings, actions }: { readonly settings: SettingsSnapshot; readonly actions: SettingsActions }) {
  const [pinned, setPinned] = useState(false);
  const rows = settings.repositories.filter((row) => row.pinned === pinned);
  return (
    <>
      <div className="seg repository-tabs" role="group" aria-label={text("settings.section.repositories")}>
        <button type="button" aria-pressed={pinned} onClick={() => setPinned(true)}>{text("repositories.pinned")}</button>
        <button type="button" aria-pressed={!pinned} onClick={() => setPinned(false)}>{text("repositories.archived")}</button>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <Icon name="repo" />
          <strong>{text(pinned ? "repositories.emptyPinned" : "repositories.emptyArchived")}</strong>
        </div>
      ) : (
        <div className="rows">
          {rows.map((row) => <RepositoryRow key={row.repository} row={row} actions={actions} />)}
        </div>
      )}
    </>
  );
}

function AppearanceSection({ appearance, choose }: { readonly appearance: Appearance; readonly choose: SettingsActions["setAppearance"] }) {
  const swatch: Readonly<Record<ThemeChoice, string>> = { system: "auto", light: "light", dark: "dark" };
  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 id="theme-title">{text("appearance.theme")}</h2>
        </div>
        <div className="theme-choices" role="radiogroup" aria-labelledby="theme-title">
          {themeChoices.map((choice) => (
            <button key={choice} className="theme-opt" type="button" role="radio" aria-checked={appearance.theme === choice} onClick={() => choose({ theme: choice })}>
              <span className={`theme-swatch theme-swatch--${swatch[choice]}`} />
              <span className="theme-name">{text(`appearance.theme.${choice}`)}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="section">
        <div className="section-head">
          <h2 id="accent-title">{text("appearance.accent")}</h2>
        </div>
        <div className="accents" role="radiogroup" aria-labelledby="accent-title">
          {accentChoices.map((choice: AccentChoice) => (
            <button
              key={choice}
              className={`accent-opt accent-opt--${choice}`}
              type="button"
              role="radio"
              aria-checked={appearance.accent === choice}
              aria-label={text(`appearance.accent.${choice}`)}
              title={text(`appearance.accent.${choice}`)}
              onClick={() => choose({ accent: choice })}
            >
              <i />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function InboxSources() {
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(true);
  const refresh = async () => {
    const response = await fetch(appPath("/api/inbox/sources"));
    if (response.status === 503) { setAvailable(false); return; }
    if (!response.ok) throw new Error();
    const body = await response.json() as { sources: { id: string; name: string }[] };
    setSources(body.sources);
  };
  useEffect(() => { void refresh().catch(() => setError(text("inbox.failed"))); }, []);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(appPath("/api/inbox/sources"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!response.ok) throw new Error();
      setCreated(await response.json() as { clientId: string; clientSecret: string });
      setName(""); await refresh();
    } catch { setError(text("inbox.failed")); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(appPath(`/api/inbox/sources/${encodeURIComponent(id)}/revoke`), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error();
      const result = await response.json() as { removed: boolean };
      if (!result.removed) setError(text("inbox.kept"));
      await refresh();
    } catch { setError(text("inbox.failed")); } finally { setBusy(false); }
  };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = created === null ? "" : `curl -H ${quote(`CF-Access-Client-Id: ${created.clientId}`)} -H ${quote(`CF-Access-Client-Secret: ${created.clientSecret}`)} -H 'Content-Type: application/json' -d '{"text":"hi"}' ${quote(`${window.location.origin}/inbox/message`)}`;
  if (!available) return null;
  return <section className="section">
    <div className="section-head"><h2>{text("inbox.title")}</h2></div>
    <div className="rows">{sources.map((source) => <div className="srow" key={source.id}><span className="srow-title">{source.name}</span><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void revoke(source.id)}>{text("inbox.revoke")}</button></div>)}</div>
    <form className="od-row" onSubmit={(event) => void add(event)}><label htmlFor="inbox-name">{text("inbox.name")}</label><input className="field" id="inbox-name" value={name} onChange={(event) => setName(event.currentTarget.value)} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" required /><button className="btn btn-sm" disabled={busy || created !== null}>{text("inbox.add")}</button></form>
    {error === "" ? null : <p className="field-err" role="alert">{error}</p>}
    {created === null ? null : <div className="card card-pad od-stack"><p>{text("inbox.once")}</p><textarea className="field" readOnly value={command} rows={5} /><div className="od-row"><button className="btn btn-sm" type="button" onClick={() => void navigator.clipboard.writeText(command)}>{text("inbox.copy")}</button><button className="btn btn-sm" type="button" onClick={() => setCreated(null)}>{text("inbox.close")}</button></div></div>}
  </section>;
}

function ConnectionsSection({ settings, now }: { readonly settings: SettingsSnapshot; readonly now: number }) {
  const gateway = settings.appGateway;
  const features = settings.features;
  const accounts = settings.accounts.filter((account) => features === undefined || account.configured);
  const brain = providerRows(settings.brain.order, settings.brain.providers).filter(({ provider }) => features === undefined || features.brainProviders.includes(provider));
  const mailboxLabel = (provider: string, label: string) => provider === "outlook" && label.includes("@") ? `Outlook · ${label}` : label;
  const connectedApps = gateway === undefined ? [] : [
    ...gateway.mailboxes.flatMap(({ provider, label, reading }) => reading === undefined ? [mailboxLabel(provider, label)] : []),
    ...(gateway.teams ? ["Microsoft Teams"] : []),
    ...(gateway.ticktick ? ["TickTick"] : []),
  ];
  return (
    <>
      {featureEnabled(features, "inboxSources") ? <InboxSources /> : null}
      {gateway === undefined ? null : (
        <section className="section">
          <div className="rows">
            <div className="srow">
              <span className={`dot ${gateway.connected ? "dot--ok" : "dot--bad"}`} />
              <div className="srow-text">
                <span className="srow-title">{text(gateway.connected ? "connections.appGatewayConnected" : "connections.appGatewayDisconnected")}</span>
                {connectedApps.length === 0 ? null : <span className="srow-help">{connectedApps.join("、")}</span>}
              </div>
            </div>
            {gateway.mailboxes.map(({ provider, label, reading }, index) => reading === undefined ? null : (
              <div className="srow" key={`${provider}-${index}`}>
                <span className={`dot ${reading === "reading" ? "dot--ok" : reading === "stalled" ? "dot--bad" : ""}`} />
                <div className="srow-text">
                  <span className="srow-title">{mailboxLabel(provider, label)}</span>
                  <span className="srow-help">{text(`connections.mail.${reading}`)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {accounts.length === 0 ? null : <section className="section">
        <div className="section-head">
          <h2>{text("connections.github")}</h2>
        </div>
        <div className="rows">
          {accounts.map((account) => (
            <div className="srow" key={account.account}>
              <span className={`dot ${account.configured ? "dot--ok" : "dot--bad"}`} />
              <div className="srow-text">
                <span className="srow-title mono">{account.account}</span>
                <span className="srow-help">{account.configured ? text("connections.configured") : text("connections.missing")}</span>
              </div>
            </div>
          ))}
        </div>
      </section>}
      {brain.length === 0 ? null : <section className="section">
        <div className="section-head">
          <h2>{text("connections.brain")}</h2>
        </div>
        <div className="rows">
          {settings.brain.linked ? null : (
            <div className="srow">
              <span className="dot dot--bad" />
              <div className="srow-text">
                <span className="srow-title">{text("brain.offline")}</span>
              </div>
            </div>
          )}
          {brain.map((row) => {
            const available = settings.brain.linked ? availableNow(row.state, now) : undefined;
            const subscription = subscriptionOf(settings.subscriptions, row.provider);
            const workers = workersOut(settings.unavailable, row.provider);
            const state = available === undefined ? null : available ? text("connections.available") : row.state?.until === null || row.state === undefined ? text("connections.unavailable") : `${text("connections.unavailable")} · ${text("connections.until", { time: momentOf(row.state.until, now) })}`;
            const left =
              subscription === undefined
                ? null
                : subscription.state === "exhausted"
                  ? text("connections.exhausted")
                  : subscription.remainingPercent === null
                    ? text("connections.unknown")
                    : text("connections.used", { percent: Math.round(Math.max(0, Math.min(100, 100 - subscription.remainingPercent))) });
            return (
              <div className="srow" key={row.provider}>
                <span className={`dot ${available === undefined ? "dot--mute" : available ? "dot--ok" : "dot--warn"}`} />
                <div className="srow-text">
                  <span className="srow-title">{text(`provider.${row.provider}`)}</span>
                  {row.state === undefined ? null : <span className="srow-help mono">{`${row.state.model} · ${row.state.effort}`}</span>}
                </div>
                <div className="srow-ctl srow-ctl--end srow-facts">
                  {state === null ? null : <span>{state}</span>}
                  {workers === undefined ? null : <span className="chip chip--bad">{workers.until === null ? text("connections.workersUnavailable") : text("connections.workersUntil", { time: momentOf(workers.until, now) })}</span>}
                  {left === null ? null : <span className={subscription?.state === "exhausted" ? "chip chip--bad" : "chip"}>{left}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>}
      {featureEnabled(features, "push") ? <section className="section">
        <div className="section-head">
          <h2>{text("connections.devices")}</h2>
          <span className="count">{settings.devices.length}</span>
        </div>
        <div className="rows">
          {settings.devices.length === 0 ? (
            <div className="srow">
              <span className="srow-help">{text("connections.noDevices")}</span>
            </div>
          ) : (
            settings.devices.map((device) => (
              <div className="srow" key={device.id}>
                <span className="dot dot--ok" />
                <div className="srow-text">
                  <span className="srow-title">{text(`device.${device.service}`)}</span>
                  <span className="srow-help">{text("connections.since", { time: momentOf(device.createdAt, now) })}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </section> : null}
    </>
  );
}

const UsageReport = z.object({
  daily: z.array(z.object({ day: z.string(), provider: z.string(), input: z.number().nullable(), cacheRead: z.number().nullable(), cacheWrite: z.number().nullable(), output: z.number().nullable(), reasoning: z.number().nullable(), costUsd: z.number().nullable(), attempts: z.number() })),
  topics: z.array(z.object({ topic: z.string(), title: z.string(), tokens: z.number() })),
  seeds: z.array(z.object({ turn: z.string(), at: z.number(), provider: z.string(), title: z.string(), seed: z.record(z.string(), z.number()) })),
});
type UsageRow = z.infer<typeof UsageReport>["daily"][number];

function OpenAIBudget({ budget }: { readonly budget: number | null }) {
  const [draft, setDraft] = useState(budget === null ? "" : String(budget));
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim() === "" ? null : Number(draft);
    if (value !== null && (!Number.isFinite(value) || value <= 0)) { setError(true); return; }
    try {
      const response = await fetch(appPath("/api/settings/openai-budget"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ budget: value }) });
      if (!response.ok) throw new Error("save failed");
      setError(false); setSaved(true);
    } catch { setError(true); setSaved(false); }
  };
  return <section className="section"><form className="usage-budget" onSubmit={(event) => void save(event)}><label>{text("usage.openaiBudget")} <input className="field" type="number" min="0.01" step="0.01" inputMode="decimal" value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); }} /></label> <button className="btn btn-sm" type="submit">{text("usage.budgetSave")}</button>{error ? <span role="alert">{text("usage.budgetError")}</span> : saved ? <span role="status">{text("usage.budgetSaved")}</span> : null}</form></section>;
}

function UsageSection({ budget }: { readonly budget: number | null | undefined }) {
  const [report, setReport] = useState<z.infer<typeof UsageReport> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(appPath("/api/brain/usage"), { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Usage request failed");
      setReport(UsageReport.parse(await response.json()));
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  if (error) return <>{budget === undefined ? null : <OpenAIBudget budget={budget} />}<div role="alert">{text("usage.error")}</div></>;
  if (report === null) return <>{budget === undefined ? null : <OpenAIBudget budget={budget} />}<div role="status">{text("usage.loading")}</div></>;
  const number = (value: number | null) => value === null ? "?" : value.toLocaleString();
  const totals = [...new Set(report.daily.map((item) => item.provider))].map((provider): UsageRow => {
    const rows = report.daily.filter((item) => item.provider === provider);
    const sum = (key: "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning" | "costUsd") => {
      const values = rows.flatMap((item) => item[key] === null ? [] : [item[key]]);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
    };
    return { day: "", provider, input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), output: sum("output"), reasoning: sum("reasoning"), costUsd: sum("costUsd"), attempts: rows.reduce((a, b) => a + b.attempts, 0) };
  });
  const row = (item: UsageRow) => <tr key={`${item.day}-${item.provider}`}><td>{item.day}</td><td>{item.provider}</td><td>{number(item.input)}</td><td>{number(item.cacheRead)}</td><td>{number(item.cacheWrite)}</td><td>{number(item.output)}</td></tr>;
  return <>
    {budget === undefined ? null : <OpenAIBudget budget={budget} />}
    <section className="section"><div className="section-head"><h2>{text("usage.totals")}</h2></div>
      {totals.length === 0 ? <div>{text("usage.empty")}</div> : <div style={{ overflowX: "auto" }}><table className="usage-table"><thead><tr><th>{text("usage.date")}</th><th>{text("usage.provider")}</th><th>{text("usage.input")}</th><th>{text("usage.cacheRead")}</th><th>{text("usage.cacheWrite")}</th><th>{text("usage.output")}</th></tr></thead><tbody>{totals.map(row)}</tbody></table></div>}
    </section>
    <section className="section"><div className="section-head"><h2>{text("usage.daily")}</h2></div>
      {report.daily.length === 0 ? <div>{text("usage.empty")}</div> : <div style={{ overflowX: "auto" }}><table className="usage-table"><thead><tr><th>{text("usage.date")}</th><th>{text("usage.provider")}</th><th>{text("usage.input")}</th><th>{text("usage.cacheRead")}</th><th>{text("usage.cacheWrite")}</th><th>{text("usage.output")}</th></tr></thead><tbody>{report.daily.map(row)}</tbody></table></div>}
    </section>
    <section className="section"><div className="section-head"><h2>{text("usage.seeds")}</h2></div>
      {report.seeds.length === 0 ? <div>{text("usage.empty")}</div> : <div className="rows">{report.seeds.map((item, index) => <details className="srow usage-seed" key={`${item.turn}-${index}`}><summary>{item.title || item.turn} ? {item.provider} ? {new Date(item.at).toLocaleString()}</summary><div>{(["input", "quote", "summary", "history", "memory", "tickets", "board", "status"] as const).map((key) => <div key={key}>{text(`usage.seed.${key}`)}: {number(item.seed[key] ?? null)}</div>)}</div></details>)}</div>}
    </section>
    <section className="section"><div className="section-head"><h2>{text("usage.topics")}</h2></div>
      {report.topics.length === 0 ? <div>{text("usage.empty")}</div> : <div className="rows">{report.topics.map((topic) => <div className="srow" key={topic.topic}><span className="srow-text">{topic.title || topic.topic}</span><span>{number(topic.tokens)}</span></div>)}</div>}
    </section>
  </>;
}

export function settingsSectionEnabled(section: SettingsSection, settings: SettingsSnapshot | null): boolean {
  const features = settings?.features;
  if (features === undefined && settings !== null) return true;
  if (section === "models") return !!features && (features.workerPrograms.length > 0 || features.brainProviders.length > 0);
  if (section === "connections") return !!features && (
    features.brainProviders.length > 0 || settings?.accounts.some((account) => account.configured) === true
    || features.enabled.some((feature) => feature === "inboxSources" || feature === "appGateway" || feature === "push")
  );
  return true;
}

export function SettingsView({ section, settings, tickets, appearance, actions, navigate, now, history }: SettingsViewProps) {
  const groups = settingsGroups.map((group) => ({ ...group, sections: group.sections.filter((item) => settingsSectionEnabled(item, settings)) })).filter((group) => group.sections.length > 0);
  const active = section ?? firstSection;
  const link = (target: SettingsSection | null) => {
    const route = routeOf(target);
    return { href: pagePath(route), onClick: (event: React.MouseEvent) => followLink(event, () => navigate(route)) };
  };
  const body = () => {
    if (active === "history") return history;
    if (active === "usage") return <UsageSection budget={settings === null || !featureEnabled(settings.features, "openaiCosts") ? undefined : settings.openaiBudget ?? null} />;
    if (active === "appearance") {
      return <AppearanceSection appearance={appearance} choose={actions.setAppearance} />;
    }
    if (settings === null) {
      return (
        <div className="empty" role="status">
          <strong>{text("settings.loading")}</strong>
        </div>
      );
    }
    switch (active) {
      case "machines":
        return <MachinesSection settings={settings} tickets={tickets} actions={actions} now={now} />;
      case "models":
        return <ModelsSection settings={settings} actions={actions} />;
      case "repositories":
        return <RepositoriesSection settings={settings} actions={actions} />;
      case "connections":
        return <ConnectionsSection settings={settings} now={now} />;
    }
  };
  return (
    <div className="page">
      <div className={section === null ? "settings" : "settings is-section"}>
        <nav className="set-nav" aria-label={text("settings.sections")}>
          {groups.map((group) => (
            <div className="set-group" key={group.group}>
              <p className="set-group-title">{text(`settings.group.${group.group}`)}</p>
              <ul className="nav">
                {group.sections.map((item) => (
                  <li key={item}>
                    <a className="nav-btn" {...link(item)} aria-current={item === active ? "page" : undefined}>
                      <Icon name={sectionIcons[item]} />
                      <span className="nav-label">{text(`settings.section.${item}`)}</span>
                      {item === "machines" && settings !== null && settings.machines.length > 0 ? <span className="count">{`${onlineCount(settings.machines)}/${settings.machines.length}`}</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="set-body">
          <div className="od-row">
            <a className="back set-back" {...link(null)}>
              <Icon name="back" />
              {text("navigation.settings")}
            </a>
          </div>
          <h2 className="set-title">{text(`settings.section.${active}`)}</h2>
          {body()}
        </div>
      </div>
    </div>
  );
}
