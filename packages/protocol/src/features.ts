import { z } from "zod";
import { ProgramId } from "./runner.js";
import { Provider } from "./conversations.js";

export const hubFeatureNames = [
  "access", "inbox", "inboxSources", "oauthMcp", "deviceTransfer", "push", "voice", "officePreviews", "openaiCosts",
  "appGateway", "mail", "mailIntake", "teams", "ticktick", "agentWring", "woodpecker", "workRequests",
] as const;
export const HubFeature = z.enum(hubFeatureNames);
export type HubFeature = z.infer<typeof HubFeature>;

export const HubFeatures = z.object({
  enabled: z.array(HubFeature),
  workerPrograms: z.array(ProgramId),
  brainProviders: z.array(Provider),
  extraMcp: z.array(z.string()),
});
export type HubFeatures = z.infer<typeof HubFeatures>;

export function hasTransfer(enabled: readonly HubFeature[]): boolean {
  return enabled.includes("deviceTransfer") || enabled.includes("inbox") || enabled.includes("oauthMcp");
}
