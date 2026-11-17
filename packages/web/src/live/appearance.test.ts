import { describe, expect, it } from "vitest";
import css from "../styles/page.css?raw";
import * as script from "../theme/appearance.js";
import { accentChoices, accentKey, appearanceEvent, readAppearance, themeChoices, themeKey, writeAppearance } from "./appearance.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("the appearance kept in the browser", () => {
  it("is read the same way by the page and by the script that runs before the first paint", () => {
    expect(themeKey).toBe(script.themeKey);
    expect(accentKey).toBe(script.accentKey);
    expect(appearanceEvent).toBe(script.appearanceEvent);
    expect(themeChoices).toEqual(script.themeChoices);
    expect(accentChoices).toEqual(script.accentChoices);
  });

  it("falls back to the system and the first accent, and survives a storage that throws", () => {
    expect(readAppearance(memoryStorage())).toEqual({ theme: "system", accent: "amber" });
    expect(readAppearance(memoryStorage({ [themeKey]: "dark", [accentKey]: "teal" }))).toEqual({ theme: "dark", accent: "teal" });
    expect(readAppearance(memoryStorage({ [themeKey]: "neon", [accentKey]: "#ff0000" }))).toEqual({ theme: "system", accent: "amber" });
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readAppearance(broken)).toEqual({ theme: "system", accent: "amber" });
    expect(writeAppearance(broken, { theme: "dark" })).toBe(false);
    expect(readAppearance(undefined)).toEqual({ theme: "system", accent: "amber" });
  });

  it("writes only what changed", () => {
    const storage = memoryStorage();
    expect(writeAppearance(storage, { accent: "rose" })).toBe(true);
    expect([...storage.values.entries()]).toEqual([[accentKey, "rose"]]);
  });

  it("is applied as attributes, with the system's preference when it follows the system", () => {
    expect(script.attributesOf(null, null, true)).toEqual({ theme: "light", accent: null, color: "#f6f5f3" });
    expect(script.attributesOf("dark", "blue", true)).toEqual({ theme: "dark", accent: "blue", color: "#161514" });
    expect(script.attributesOf("system", "amber", false)).toEqual({ theme: "dark", accent: null, color: "#161514" });
    expect(script.concernsAppearance(themeKey)).toBe(true);
    expect(script.concernsAppearance(null)).toBe(true);
    expect(script.concernsAppearance("other")).toBe(false);
  });
});

const ground: Record<"light" | "dark", { readonly bg: string; readonly surface: string }> = {
  dark: { bg: "#161514", surface: "#1e1d1b" },
  light: { bg: "#f6f5f3", surface: "#ffffff" },
};

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => channel(parseInt(hex.slice(index, index + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  return Object.fromEntries(
    body
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("--"))
      .map((part) => [part.slice(0, part.indexOf(":")).trim(), part.slice(part.indexOf(":") + 1).trim()]),
  );
}

describe("every accent", () => {
  it("reads the stylesheet", () => {
    expect(css.length).toBeGreaterThan(100);
  });

  it("keeps accent text readable and accent buttons legible on both grounds", () => {
    for (const accent of accentChoices.filter((choice) => choice !== "amber")) {
      for (const theme of ["dark", "light"] as const) {
        const selector = theme === "dark" ? `:root[data-accent="${accent}"]` : `:root[data-theme="light"][data-accent="${accent}"]`;
        const values = tokens(css, selector);
        const meta = values["--meta"] ?? "";
        const fill = values["--accent"] ?? "";
        const on = values["--accent-on"] ?? "";
        expect(contrast(meta, ground[theme].surface), `${accent} ${theme} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(meta, ground[theme].bg), `${accent} ${theme} text on the page`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(fill, on), `${accent} ${theme} button`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
