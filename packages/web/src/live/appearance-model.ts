export const themeKey = "superagent2.theme";
export const accentKey = "superagent2.accent";
export const appearanceEvent = "superagent2-appearance";

export const themeChoices = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof themeChoices)[number];
export const accentChoices = ["orange", "amber", "teal", "blue", "purple", "rose", "graphite"] as const;
export type AccentPreset = (typeof accentChoices)[number];
export type AccentChoice = AccentPreset | `#${string}`;
export const defaultAccent: AccentPreset = "orange";
export const accentColors: Record<AccentPreset, string> = {
  orange: "#f97316", amber: "#f2b705", teal: "#3fb68b", blue: "#5b8def",
  purple: "#a07cf0", rose: "#e46f8f", graphite: "#d6d0c4",
};
export type ShownTheme = "light" | "dark";

export function readTheme(value: string | null): ThemeChoice {
  return themeChoices.find((choice) => choice === value) ?? "system";
}

export function readAccent(value: string | null): AccentChoice {
  const preset = accentChoices.find((choice) => choice === value);
  return preset ?? (value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() as `#${string}` : defaultAccent);
}

export function accentColor(accent: AccentChoice): string {
  return accent.startsWith("#") ? accent : accentColors[accent as AccentPreset];
}

function luminance(rgb: number[]): number {
  const channels = rgb.map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: number[], b: number[]): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function accentTokens(accent: AccentChoice, theme: ShownTheme): Record<string, string> {
  const color = accentColor(accent);
  const rgb = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  const ground = theme === "light" ? [246, 245, 243] : [30, 29, 27];
  const target = theme === "light" ? black : white;
  let meta = rgb;
  for (let step = 0; step <= 100 && contrast(meta, ground) < 4.5; step++) {
    meta = rgb.map((value, index) => Math.round(value + ((target[index] ?? 0) - value) * step / 100));
  }
  const hex = (values: number[]) => `#${values.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return {
    "--accent": color,
    "--accent-on": contrast(rgb, black) >= contrast(rgb, white) ? "#000000" : "#ffffff",
    "--accent-soft": `rgba(${rgb.join(", ")}, ${theme === "light" ? "0.16" : "0.14"})`,
    "--meta": hex(meta),
    "--focus-ring": `0 0 0 3px rgba(${rgb.join(", ")}, 0.45)`,
  };
}

export function shownTheme(choice: ThemeChoice, prefersLight: boolean): ShownTheme {
  return choice === "system" ? (prefersLight ? "light" : "dark") : choice;
}
export function themeColor(theme: ShownTheme): string {
  return theme === "light" ? "#f6f5f3" : "#161514";
}
export function attributesOf(storedTheme: string | null, storedAccent: string | null, prefersLight: boolean) {
  const theme = shownTheme(readTheme(storedTheme), prefersLight);
  return { theme, accent: readAccent(storedAccent), color: themeColor(theme) };
}
export function concernsAppearance(key: string | null): boolean {
  return key === null || key === themeKey || key === accentKey;
}
