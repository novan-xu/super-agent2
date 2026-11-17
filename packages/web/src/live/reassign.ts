import { type ChoiceChange, engineOn, type MachineChoice, machinesFor, offers, type ProgramId, type Ticket } from "@super-agent2/protocol";
import { type ChoiceOptions, choiceOptions, parseModelValue } from "./choice.js";

export interface ReassignDraft {
  readonly machine: string | null;
  readonly engine: ProgramId | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export function initialDraft(ticket: Ticket): ReassignDraft {
  return { machine: ticket.machine, engine: ticket.engine, model: ticket.model, effort: ticket.effort };
}

export function reassignMachines(ticket: Ticket, machines: readonly MachineChoice[]): MachineChoice[] {
  return machinesFor(ticket.platform, machines).map((machine) => ({
    ...machine,
    engines: ticket.kind === "writing" ? machine.engines : machine.engines.filter((offer) => offer.engine !== "antigravity"),
  }));
}

export function draftOptions(draft: ReassignDraft, machines: readonly MachineChoice[]): ChoiceOptions {
  return choiceOptions({ machines, choice: draft });
}

export function draftWithMachine(draft: ReassignDraft, name: string, machines: readonly MachineChoice[]): ReassignDraft {
  const target = machines.find((machine) => machine.name === name);
  const engine = draft.engine !== null && engineOn(target, draft.engine) !== undefined ? draft.engine : (target?.engines[0]?.engine ?? null);
  const keepModel = engine !== null && engine === draft.engine && draft.model !== null && draft.effort !== null && offers(target, engine, draft.model, draft.effort);
  return { machine: name, engine, model: keepModel ? draft.model : null, effort: keepModel ? draft.effort : null };
}

export function draftWithEngine(draft: ReassignDraft, engine: ProgramId): ReassignDraft {
  return engine === draft.engine ? draft : { ...draft, engine, model: null, effort: null };
}

export function draftWithModel(draft: ReassignDraft, value: string): ReassignDraft {
  if (value === "") {
    return { ...draft, model: null, effort: null };
  }
  const parsed = parseModelValue(value);
  return parsed === undefined ? draft : { ...draft, model: parsed.model, effort: parsed.effort };
}

export function reassignChange(draft: ReassignDraft): ChoiceChange | undefined {
  if (draft.machine === null || draft.engine === null) {
    return undefined;
  }
  return draft.model === null || draft.effort === null
    ? { machine: draft.machine, engine: draft.engine }
    : { machine: draft.machine, engine: draft.engine, model: draft.model, effort: draft.effort };
}
