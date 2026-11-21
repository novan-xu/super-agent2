import { type ChoiceChange, engineOn, isComplete, type MachineChoice, offers, type ProgramId, type StartCard, waitsForProvider } from "@super-agent2/protocol";

export interface ChoiceOptions {
  readonly machines: readonly string[];
  readonly engines: readonly ProgramId[];
  readonly models: readonly string[];
  readonly efforts: readonly string[];
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

export function offersModel(machine: MachineChoice | undefined, engine: ProgramId | null, model: string | null): boolean {
  return engine !== null && model !== null && (engineOn(machine, engine)?.models.some((offered) => offered.id === model) ?? false);
}

export function choiceOptions(card: ChoiceSource): ChoiceOptions {
  const { choice } = card;
  const machine = machineOf(card);
  const engines = machine?.engines.map((offer) => offer.engine) ?? [];
  const offered = choice.engine === null ? [] : (engineOn(machine, choice.engine)?.models ?? []);
  const efforts = offered.find((model) => model.id === choice.model)?.efforts ?? [];
  return {
    machines: withCurrent(
      card.machines.map((entry) => entry.name),
      choice.machine,
    ),
    engines: withCurrent(engines, choice.engine),
    models: withCurrent(
      offered.map((model) => model.id),
      choice.model,
    ),
    efforts: withCurrent(efforts, choice.effort),
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
  const { model, effort } = card.choice;
  if (!offersModel(target, keptEngine, model)) {
    if (owner.model !== null) {
      change.model = null;
    }
    if (owner.effort !== null) {
      change.effort = null;
    }
  } else if (owner.effort !== null && (keptEngine === null || model === null || effort === null || !offers(target, keptEngine, model, effort))) {
    change.effort = null;
  }
  return change;
}

export function changeOfEngine(engine: ProgramId): ChoiceChange {
  return { engine, model: null, effort: null };
}

export function changeOfModel(card: StartCard, model: string): ChoiceChange {
  const machine = card.machines.find((entry) => entry.name === card.choice.machine);
  const { engine, effort } = card.choice;
  const keeps = engine !== null && effort !== null && offers(machine, engine, model, effort);
  return keeps || card.ticket.ownerChoice.effort === null ? { model } : { model, effort: null };
}

export function changeOfEffort(effort: string): ChoiceChange {
  return { effort };
}

export function canStartCard(card: StartCard): boolean {
  return card.startable && (isComplete(card.choice) || waitsForProvider(card.choice));
}
