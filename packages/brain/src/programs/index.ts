import type { Provider } from "@super-agent2/protocol";
import type { ProgramAdapter } from "../program.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { dshAdapter } from "./dsh.js";
import type { ProgramSettings } from "./settings.js";

export * from "./claude.js";
export * from "./codex.js";
export * from "./dsh.js";
export * from "./process.js";
export * from "./settings.js";

export function programAdapter(provider: Provider, settings: ProgramSettings): ProgramAdapter {
  switch (provider) {
    case "gpt":
      return codexAdapter(settings);
    case "claude":
      return claudeAdapter(settings);
    case "deepseek":
      return dshAdapter(settings);
  }
}
