import { accentChoices, accentKey, appearanceEvent, readAccent, readTheme, themeChoices, themeKey } from "./appearance-model.js";
import type { AccentChoice, ThemeChoice } from "./appearance-model.js";
export { accentChoices, accentKey, appearanceEvent, themeChoices, themeKey };
export type { AccentChoice, ThemeChoice };

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
    accent = null;
  }
  return { theme: readTheme(theme), accent: readAccent(accent) };
}
export function writeAppearance(storage: AppearanceStorage | undefined, change: Partial<Appearance>): boolean {
  try {
    if (change.theme !== undefined) storage?.setItem(themeKey, change.theme);
    if (change.accent !== undefined) storage?.setItem(accentKey, readAccent(change.accent));
    return storage !== undefined;
  } catch {
    return false;
  }
}
