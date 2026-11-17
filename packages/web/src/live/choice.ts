import { type ChoiceChange, engineOn, isComplete, type MachineChoice, offers, type ProgramId, type StartCard } from "@super-agent2/protocol";

export interface ModelOption {
  readonly value: string;
  readonly model: string;
  readonly effort: string;
}

export interface ChoiceOptions {
  readonly machines: readonly string[];
  readonly engines: readonly ProgramId[];
  readonly models: readonly ModelOption[];
}

const separator = " ";

export function modelValue(model: string | null, effort: string | null): string {
  return model === null || effort === null ? "" : `${model}${separator}${effort}`;
}

export function modelLabel(option: ModelOption): string {
  return `${option.model} · ${option.effort}`;
}

export function parseModelValue(value: string): { readonly model: string; readonly effort: string } | undefined {
  const at = value.lastIndexOf(separator);
  if (at <= 0 || at === value.length - 1) {
    return undefined;
  }
  return { model: value.slice(0, at), effort: value.slice(at + 1) };
}

function withCurrent<T>(values: readonly T[], current: T | null): T[] {
  return current === null || values.includes(current) ? [...values] : [current, ...values];
}

export interface ChoiceSource {
  readonly machines: readonly MachineChoice[];
  readonly choice: { readonly machine: string | null; readonly engine: ProgramId | null; readonly model: string | null; readonly effort: string | null };
}

function machineOf(card: ChoiceSource): MachineChoice | undefined {
  return card.machines.find((machine) => machine.name === card.choice.machine);
}

export function choiceOptions(card: ChoiceSource): ChoiceOptions {
  const { choice } = card;
  const machine = machineOf(card);
  const engines = machine?.engines.map((offer) => offer.engine) ?? [];
  const offered = choice.engine === null ? [] : (engineOn(machine, choice.engine)?.models ?? []);
  const models = offered.flatMap((model) => model.efforts.map((effort) => ({ value: modelValue(model.id, effort), model: model.id, effort })));
  const current = modelValue(choice.model, choice.effort);
  const listed =
    choice.model !== null && choice.effort !== null && !models.some((option) => option.value === current)
      ? [{ value: current, model: choice.model, effort: choice.effort }, ...models]
      : models;
  return {
    machines: withCurrent(
      card.machines.map((entry) => entry.name),
      choice.machine,
    ),
    engines: withCurrent(engines, choice.engine),
    models: listed,
  };
}

export function changeOfMachine(card: StartCard, name: string): ChoiceChange {
  const owner = card.ticket.ownerChoice;
  const target = card.machines.find((machine) => machine.name === name);
  const change: { machine: string; engine?: null; model?: null; effort?: null } = { machine: name };
  const engine = owner.engine;
  if (engine !== null && engineOn(target, engine) === undefined) {
    change.engine = null;
  }
  const keptEngine = change.engine === null ? card.choice.engine : (engine ?? card.choice.engine);
  if ((owner.model !== null || owner.effort !== null) && (keptEngine === null || card.choice.model === null || card.choice.effort === null || !offers(target, keptEngine, card.choice.model, card.choice.effort))) {
    change.model = null;
    change.effort = null;
  }
  return change;
}

export function changeOfEngine(engine: ProgramId): ChoiceChange {
  return { engine, model: null, effort: null };
}

export function changeOfModel(value: string): ChoiceChange | undefined {
  const parsed = parseModelValue(value);
  return parsed === undefined ? undefined : { model: parsed.model, effort: parsed.effort };
}

export function canStartCard(card: StartCard): boolean {
  return card.startable && isComplete(card.choice);
}
