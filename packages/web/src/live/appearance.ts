export const themeKey = "superagent2.theme";
export const accentKey = "superagent2.accent";
export const appearanceEvent = "superagent2-appearance";

export const themeChoices = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof themeChoices)[number];

export const accentChoices = ["amber", "teal", "blue", "purple", "rose", "graphite"] as const;
export type AccentChoice = (typeof accentChoices)[number];

export interface Appearance {
  readonly theme: ThemeChoice;
  readonly accent: AccentChoice;
}

export interface AppearanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readAppearance(storage: AppearanceStorage | undefined): Appearance {
  let theme: string | null = null;
  let accent: string | null = null;
  try {
    theme = storage?.getItem(themeKey) ?? null;
    accent = storage?.getItem(accentKey) ?? null;
  } catch {
    theme = null;
  }
  return {
    theme: themeChoices.find((choice) => choice === theme) ?? "system",
    accent: accentChoices.find((choice) => choice === accent) ?? "amber",
  };
}

export function writeAppearance(storage: AppearanceStorage | undefined, change: Partial<Appearance>): boolean {
  try {
    if (change.theme !== undefined) {
      storage?.setItem(themeKey, change.theme);
    }
    if (change.accent !== undefined) {
      storage?.setItem(accentKey, change.accent);
    }
    return storage !== undefined;
  } catch {
    return false;
  }
}
