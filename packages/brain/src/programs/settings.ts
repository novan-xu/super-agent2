import type { Clock } from "../clock.js";

export const toolTokenVariable = "SUPER_AGENT_HUB_TOKEN";

export const conversationVariable = "SUPER_AGENT_CONVERSATION";

export interface ProgramSettings {
  readonly program: string;
  readonly model: string;
  readonly effort: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
}
