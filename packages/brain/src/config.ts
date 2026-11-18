import { type Provider, startingOrder } from "@super-agent2/protocol";
import { defaultAttachmentsFolder } from "./prompt.js";
import { z } from "zod";
import { providerOrder } from "./providers.js";

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
}

export const startingModels: Readonly<Record<Provider, { readonly model: string; readonly effort: string; readonly program: string }>> = {
  gpt: { model: "gpt-6-astra", effort: "high", program: "codex" },
  claude: { model: "claude-opus-5-5", effort: "high", program: "claude" },
  deepseek: { model: "deepseek-flash", effort: "high", program: "dsh" },
};

const text = z.string().trim().min(1, { error: "must not be empty" });

const Preferred = z
  .string()
  .default(startingOrder.join(","))
  .transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== ""))
  .pipe(
    z
      .array(z.enum(["gpt", "claude"], { error: "must list gpt and claude, in the order they answer" }))
      .min(1, { error: "must name at least one of gpt and claude" }),
  );

const Environment = z.object({
  BRAIN_HUB_URL: z.url({ protocol: /^https?$/, error: "must be the hub's http or https address" }),
  BRAIN_TOKEN_FILE: text,
  BRAIN_WORKSPACE: text,
  BRAIN_ATTACHMENTS_DIR: text.default(defaultAttachmentsFolder),
  BRAIN_PROVIDERS: Preferred,
  BRAIN_MAX_OPEN: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "must be a positive whole number" })
    .transform(Number)
    .default(4),
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
      order: providerOrder(value.BRAIN_PROVIDERS, "deepseek"),
      maximumOpen: value.BRAIN_MAX_OPEN,
      providers: {
        gpt: { program: value.BRAIN_CODEX_PROGRAM, model: value.BRAIN_GPT_MODEL, effort: value.BRAIN_GPT_EFFORT },
        claude: { program: value.BRAIN_CLAUDE_PROGRAM, model: value.BRAIN_CLAUDE_MODEL, effort: value.BRAIN_CLAUDE_EFFORT },
        deepseek: { program: value.BRAIN_DSH_PROGRAM, model: value.BRAIN_DEEPSEEK_MODEL, effort: value.BRAIN_DEEPSEEK_EFFORT },
      },
    },
  };
}
