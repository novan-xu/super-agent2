export const themeKey = "superagent2.theme";
export const accentKey = "superagent2.accent";
export const appearanceEvent = "superagent2-appearance";

export const themeChoices = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof themeChoices)[number];

export const accentChoices = ["amber", "teal", "blue", "purple", "rose", "graphite"] as const;
export type AccentChoice = (typeof accentChoices)[number];

export const defaultAccent: AccentChoice = "amber";

export type ShownTheme = "light" | "dark";

export function readTheme(value: string | null): ThemeChoice {
  return themeChoices.find((choice) => choice === value) ?? "system";
}

export function readAccent(value: string | null): AccentChoice {
  return accentChoices.find((choice) => choice === value) ?? defaultAccent;
}

export function shownTheme(choice: ThemeChoice, prefersLight: boolean): ShownTheme {
  if (choice === "system") {
    return prefersLight ? "light" : "dark";
  }
  return choice;
}

export function themeColor(theme: ShownTheme): string {
  return theme === "light" ? "#f6f5f3" : "#161514";
}

export interface AppearanceAttributes {
  readonly theme: ShownTheme;
  readonly accent: AccentChoice | null;
  readonly color: string;
}

export function attributesOf(storedTheme: string | null, storedAccent: string | null, prefersLight: boolean): AppearanceAttributes {
  const theme = shownTheme(readTheme(storedTheme), prefersLight);
  const accent = readAccent(storedAccent);
  return { theme, accent: accent === defaultAccent ? null : accent, color: themeColor(theme) };
}

export function concernsAppearance(key: string | null): boolean {
  return key === null || key === themeKey || key === accentKey;
}
