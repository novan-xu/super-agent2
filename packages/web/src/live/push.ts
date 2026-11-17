export type Permission = "default" | "granted" | "denied";

export interface PushFacts {
  readonly key: string | null | undefined;
  readonly supported: boolean;
  readonly ios: boolean;
  readonly standalone: boolean;
  readonly permission: Permission;
  readonly subscribed: boolean;
  readonly working: boolean;
}

export type PushPhase = "checking" | "hidden" | "install" | "blocked" | "off" | "on" | "working";

export const initialPushFacts: PushFacts = {
  key: undefined,
  supported: false,
  ios: false,
  standalone: false,
  permission: "default",
  subscribed: false,
  working: false,
};

export function pushPhase(facts: PushFacts): PushPhase {
  if (facts.key === undefined) {
    return "checking";
  }
  if (facts.key === null) {
    return "hidden";
  }
  if (!facts.supported) {
    return facts.ios && !facts.standalone ? "install" : "hidden";
  }
  if (facts.working) {
    return "working";
  }
  if (facts.permission === "denied") {
    return "blocked";
  }
  return facts.subscribed && facts.permission === "granted" ? "on" : "off";
}

export function offersSwitch(phase: PushPhase): boolean {
  return phase === "off" || phase === "on" || phase === "working" || phase === "blocked";
}

export function isIosDevice(userAgent: string, platform: string, touchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1);
}
