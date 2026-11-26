import { hasTransfer, type HubFeature, type HubFeatures, type ProgramId, type Provider } from "@super-agent2/protocol";
import { createContext, useContext } from "react";

export const emptyFeatures: HubFeatures = { enabled: [], workerPrograms: [], brainProviders: [], extraMcp: [] };
export const FeatureContext = createContext<HubFeatures | undefined>(undefined);

export function featureEnabled(features: HubFeatures | undefined, feature: HubFeature): boolean {
  return features === undefined || features.enabled.includes(feature);
}

export function useFeature(feature: HubFeature): boolean {
  return featureEnabled(useContext(FeatureContext), feature);
}

export function transferEnabled(features: HubFeatures | undefined): boolean {
  return features === undefined || hasTransfer(features.enabled);
}

export const programForProvider: Readonly<Record<Provider, ProgramId>> = { gpt: "codex", claude: "claude", deepseek: "dsh" };
