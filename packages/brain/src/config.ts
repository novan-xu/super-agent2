import { Provider, startingBrainOrder } from "@super-agent2/protocol";
import { defaultIdleMilliseconds } from "./brain.js";
import { defaultSoftShare, fallbackInputCapacity } from "./seed.js";
import { defaultAttachmentsFolder } from "./prompt.js";
import { z } from "zod";

export interface ProviderSettings {
  readonly program: string;
  readonly model: string;
  readonly effort: string;
}

export interface BrainConfig {
  readonly hubUrl: string;
  readonly tokenFile: string;
  readonly workspace: string;
  readonly attachments: string;
  readonly order: readonly Provider[];
  readonly providers: Readonly<Record<Provider, ProviderSettings>>;
  readonly maximumOpen: number;
  readonly idleMilliseconds: number;
  readonly seedSoftShare: number;
  readonly inputCapacity: Readonly<Record<Provider, number>>;
}

export const startingModels: Readonly<Record<Provider, { readonly model: string; readonly effort: string; readonly program: string }>> = {
  gpt: { model: "gpt-6.2-astra", effort: "high", program: "codex" },
  claude: { model: "claude-opus-5-5", effort: "high", program: "claude" },
  deepseek: { model: "deepseek-flash", effort: "high", program: "dsh" },
};

const text = z.string().trim().min(1, { error: "must not be empty" });

const Preferred = z
  .string()
  .default(startingBrainOrder.join(","))
  .transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== ""))
  .pipe(
    z
      .array(Provider)
      .min(1, { error: "must name at least one provider" }),
  );

const positiveInteger = z.string().regex(/^[1-9]\d*$/, { error: "must be a positive whole number" }).transform(Number).pipe(z.number().int().positive());
const fraction = text.transform(Number).pipe(z.number().positive().max(1));

const Environment = z.object({
  BRAIN_HUB_URL: z.url({ protocol: /^https?$/, error: "must be the hub's http or https address" }),
  BRAIN_TOKEN_FILE: text,
  BRAIN_WORKSPACE: text,
  BRAIN_ATTACHMENTS_DIR: text.default(defaultAttachmentsFolder),
  BRAIN_PROVIDERS: Preferred,
  BRAIN_MAX_OPEN: positiveInteger.default(4),
  BRAIN_IDLE_MS: positiveInteger.default(defaultIdleMilliseconds),
  BRAIN_SEED_SOFT_SHARE: fraction.default(defaultSoftShare),
  BRAIN_GPT_INPUT_CAPACITY: positiveInteger.default(fallbackInputCapacity.gpt),
  BRAIN_CLAUDE_INPUT_CAPACITY: positiveInteger.default(fallbackInputCapacity.claude),
  BRAIN_DEEPSEEK_INPUT_CAPACITY: positiveInteger.default(fallbackInputCapacity.deepseek),
  BRAIN_GPT_MODEL: text.default(startingModels.gpt.model),
  BRAIN_GPT_EFFORT: text.default(startingModels.gpt.effort),
  BRAIN_CODEX_PROGRAM: text.default(startingModels.gpt.program),
  BRAIN_CLAUDE_MODEL: text.default(startingModels.claude.model),
  BRAIN_CLAUDE_EFFORT: text.default(startingModels.claude.effort),
  BRAIN_CLAUDE_PROGRAM: text.default(startingModels.claude.program),
  BRAIN_DEEPSEEK_MODEL: text.default(startingModels.deepseek.model),
  BRAIN_DEEPSEEK_EFFORT: text.default(startingModels.deepseek.effort),
  BRAIN_DSH_PROGRAM: text.default(startingModels.deepseek.program),
});

export type BrainConfigResult = { readonly ok: true; readonly config: BrainConfig } | { readonly ok: false; readonly problems: readonly string[] };

export function loadBrainConfig(env: Readonly<Record<string, string | undefined>>): BrainConfigResult {
  const parsed = Environment.safeParse(env);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`) };
  }
  const value = parsed.data;
  return {
    ok: true,
    config: {
      hubUrl: value.BRAIN_HUB_URL,
      tokenFile: value.BRAIN_TOKEN_FILE,
      workspace: value.BRAIN_WORKSPACE,
      attachments: value.BRAIN_ATTACHMENTS_DIR,
      order: [...new Set<Provider>([...value.BRAIN_PROVIDERS, "deepseek"])],
      maximumOpen: value.BRAIN_MAX_OPEN,
      idleMilliseconds: value.BRAIN_IDLE_MS,
      seedSoftShare: value.BRAIN_SEED_SOFT_SHARE,
      inputCapacity: { gpt: value.BRAIN_GPT_INPUT_CAPACITY, claude: value.BRAIN_CLAUDE_INPUT_CAPACITY, deepseek: value.BRAIN_DEEPSEEK_INPUT_CAPACITY },
      providers: {
        gpt: { program: value.BRAIN_CODEX_PROGRAM, model: value.BRAIN_GPT_MODEL, effort: value.BRAIN_GPT_EFFORT },
        claude: { program: value.BRAIN_CLAUDE_PROGRAM, model: value.BRAIN_CLAUDE_MODEL, effort: value.BRAIN_CLAUDE_EFFORT },
        deepseek: { program: value.BRAIN_DSH_PROGRAM, model: value.BRAIN_DEEPSEEK_MODEL, effort: value.BRAIN_DEEPSEEK_EFFORT },
      },
    },
  };
}
