import { z } from "zod";
import type { AllowanceProgram, AllowanceState } from "./allowance.js";
import { MachinePlatform, type MachineStatus, ProgramId, ProgramModel } from "./runner.js";
import {
  ChosenBy,
  type Difficulty,
  difficulties,
  EffortName,
  ModelName,
  type OwnerChoice,
  type Platform,
  type TicketKind,
} from "./tickets.js";

export const ModelChoice = z.object({ model: ModelName, effort: EffortName });
export type ModelChoice = z.infer<typeof ModelChoice>;

export const DifficultyRow = z.object({ mechanical: ModelChoice, standard: ModelChoice, complex: ModelChoice });
export type DifficultyRow = z.infer<typeof DifficultyRow>;

export const EngineTable = z.object({
  codex: DifficultyRow,
  claude: DifficultyRow,
  dsh: DifficultyRow,
  antigravity: ModelChoice,
});
export type EngineTable = z.infer<typeof EngineTable>;

export const startingEngineTable: EngineTable = {
  codex: {
    mechanical: { model: "gpt-6-luna", effort: "medium" },
    standard: { model: "gpt-6.1-terra", effort: "high" },
    complex: { model: "gpt-6.1-sol", effort: "high" },
  },
  claude: {
    mechanical: { model: "claude-haiku-5-5", effort: "medium" },
    standard: { model: "claude-sonnet-5-5", effort: "high" },
    complex: { model: "claude-opus-5-5", effort: "high" },
  },
  dsh: {
    mechanical: { model: "deepseek-flash", effort: "low" },
    standard: { model: "deepseek-flash", effort: "high" },
    complex: { model: "deepseek-flash", effort: "max" },
  },
  antigravity: { model: "gemini-3.8-flash", effort: "high" },
};

export const EngineTableBody = z.object({ table: EngineTable });
export type EngineTableBody = z.infer<typeof EngineTableBody>;

export function tableChoice(table: EngineTable, engine: ProgramId, difficulty: Difficulty | null): ModelChoice | null {
  if (engine === "antigravity") {
    return table.antigravity;
  }
  return difficulty === null ? null : table[engine][difficulty];
}

export function chainDifficulty(values: readonly (Difficulty | null)[]): Difficulty | null {
  let best: Difficulty | null = null;
  for (const value of values) {
    if (value !== null && (best === null || difficulties.indexOf(value) > difficulties.indexOf(best))) {
      best = value;
    }
  }
  return best;
}

export const codeEngineChoices = ["codex", "claude"] as const;
export const CodeEngineChoice = z.enum(codeEngineChoices);
export type CodeEngineChoice = z.infer<typeof CodeEngineChoice>;

export type AllowanceStates = Readonly<Record<AllowanceProgram, AllowanceState>>;

export function defaultEngine(kind: TicketKind, brainEngine: ProgramId | null, allowance: AllowanceStates): ProgramId | null {
  if (kind === "writing") {
    return "antigravity";
  }
  if (allowance.codex === "exhausted" && allowance.claude === "exhausted") {
    return "dsh";
  }
  if (brainEngine !== "codex" && brainEngine !== "claude") {
    return null;
  }
  const other = brainEngine === "codex" ? "claude" : "codex";
  return allowance[brainEngine] === "exhausted" && allowance[other] !== "exhausted" ? other : brainEngine;
}

export const EngineOffer = z.object({ engine: ProgramId, models: z.array(ProgramModel) });
export type EngineOffer = z.infer<typeof EngineOffer>;

export const MachineChoice = z.object({
  name: z.string().min(1),
  platform: MachinePlatform,
  free: z.number().int().nonnegative(),
  engines: z.array(EngineOffer),
});
export type MachineChoice = z.infer<typeof MachineChoice>;

export function machineChoices(statuses: readonly MachineStatus[]): MachineChoice[] {
  return statuses.flatMap((status) => {
    const report = status.report;
    if (!status.online || report === null) {
      return [];
    }
    return [
      {
        name: status.name,
        platform: report.platform,
        free: report.slots.free,
        engines: report.programs.filter((program) => program.installed).map((program) => ({ engine: program.id, models: program.models })),
      },
    ];
  });
}

export function fitsPlatform(platform: Platform, system: MachinePlatform): boolean {
  if (platform === "any") {
    return true;
  }
  return platform === "macos" ? system === "darwin" : system === "win32";
}

export function machinesFor(platform: Platform | null, machines: readonly MachineChoice[], required: string | null = null): MachineChoice[] {
  if (required !== null) {
    return machines.filter((machine) => machine.name === required);
  }
  return platform === null ? [...machines] : machines.filter((machine) => fitsPlatform(platform, machine.platform));
}

export function engineOn(machine: MachineChoice | undefined, engine: ProgramId): EngineOffer | undefined {
  return machine?.engines.find((offer) => offer.engine === engine);
}

export function offers(machine: MachineChoice | undefined, engine: ProgramId, model: string, effort: string): boolean {
  return engineOn(machine, engine)?.models.some((offered) => offered.id === model && offered.efforts.includes(effort)) ?? false;
}

export function defaultMachine(platform: Platform, engine: ProgramId, machines: readonly MachineChoice[]): string | null {
  const candidates = machinesFor(platform, machines)
    .filter((machine) => engineOn(machine, engine) !== undefined)
    .sort((a, b) => b.free - a.free || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return candidates[0]?.name ?? null;
}

export const missingParts = ["defaults", "machine", "engine", "model", "effort"] as const;
export const MissingPart = z.enum(missingParts);
export type MissingPart = z.infer<typeof MissingPart>;

export const StartChoice = z.object({
  machine: z.string().nullable(),
  engine: ProgramId.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  by: ChosenBy,
  missing: z.array(MissingPart),
});
export type StartChoice = z.infer<typeof StartChoice>;

export interface StartInput {
  readonly kind: TicketKind;
  readonly difficulty: Difficulty | null;
  readonly platform: Platform | null;
  readonly requiredMachine?: string | null;
  readonly brainEngine: ProgramId | null;
  readonly stated: boolean;
  readonly owner: OwnerChoice;
}

export function resolveStart(input: StartInput, table: EngineTable, machines: readonly MachineChoice[], allowance: AllowanceStates): StartChoice {
  const { owner } = input;
  const engine = owner.engine ?? (input.stated || input.kind === "writing" ? defaultEngine(input.kind, input.brainEngine, allowance) : null);
  const required = input.requiredMachine ?? null;
  const machine = owner.machine ?? required ?? (input.platform !== null && engine !== null ? defaultMachine(input.platform, engine, machines) : null);
  const fromTable = engine === null ? null : tableChoice(table, engine, input.difficulty);
  const model = owner.model ?? fromTable?.model ?? null;
  const effort = owner.effort ?? fromTable?.effort ?? null;
  const missing = new Set<MissingPart>();
  if (!input.stated) {
    missing.add("defaults");
  }
  const chosen = machine === null ? undefined : machines.find((entry) => entry.name === machine);
  if (machine === null) {
    if (engine !== null && input.platform !== null) {
      missing.add(machinesFor(input.platform, machines).length === 0 ? "machine" : "engine");
    }
  } else if (required !== null && machine !== required) {
    missing.add("machine");
  } else if (chosen === undefined) {
    missing.add("machine");
  } else if (engine !== null && engineOn(chosen, engine) === undefined) {
    missing.add("engine");
  } else if (engine !== null && model !== null && effort !== null && !offers(chosen, engine, model, effort)) {
    missing.add(engineOn(chosen, engine)?.models.some((offered) => offered.id === model) === true ? "effort" : "model");
  }
  if ((machine === null || engine === null || model === null || effort === null) && missing.size === 0) {
    missing.add("defaults");
  }
  return {
    machine,
    engine,
    model,
    effort,
    by: {
      machine: owner.machine === null ? "default" : "owner",
      engine: owner.engine === null ? "default" : "owner",
      model: owner.model === null ? "default" : "owner",
      effort: owner.effort === null ? "default" : "owner",
    },
    missing: missingParts.filter((part) => missing.has(part)),
  };
}

export function isComplete(choice: StartChoice): boolean {
  return choice.missing.length === 0 && choice.machine !== null && choice.engine !== null && choice.model !== null && choice.effort !== null;
}

export const ChoiceChange = z.object({
  machine: z.string().min(1).max(63).nullable().optional(),
  engine: ProgramId.nullable().optional(),
  model: ModelName.nullable().optional(),
  effort: EffortName.nullable().optional(),
});
export type ChoiceChange = z.infer<typeof ChoiceChange>;

export const ChainChoice = ChoiceChange.extend({ ticket: z.number().int().positive() });
export type ChainChoice = z.infer<typeof ChainChoice>;

export function applyChange(owner: OwnerChoice, change: ChoiceChange): OwnerChoice {
  return {
    machine: change.machine === undefined ? owner.machine : change.machine,
    engine: change.engine === undefined ? owner.engine : change.engine,
    model: change.model === undefined ? owner.model : change.model,
    effort: change.effort === undefined ? owner.effort : change.effort,
  };
}

export function ownerGivesUnoffered(owner: OwnerChoice, choice: StartChoice, machines: readonly MachineChoice[], required: string | null = null): boolean {
  if (owner.machine !== null && !machines.some((machine) => machine.name === owner.machine)) {
    return true;
  }
  if (owner.machine !== null && required !== null && owner.machine !== required) {
    return true;
  }
  const machine = machines.find((entry) => entry.name === choice.machine);
  if (owner.engine !== null && machine !== undefined && engineOn(machine, owner.engine) === undefined) {
    return true;
  }
  if ((owner.model !== null || owner.effort !== null) && choice.engine !== null && choice.model !== null && choice.effort !== null) {
    return machine === undefined || !offers(machine, choice.engine, choice.model, choice.effort);
  }
  return false;
}
