import { afterEach, expect, it, vi } from "vitest";
import { accentTokens, appearanceEvent } from "./appearance.js";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("applies saved and changed accents in both themes", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));
  localStorage.setItem("superagent2.theme", "dark");
  localStorage.setItem("superagent2.accent", "teal");
  await import("./theme.js");
  for (const [theme, accent] of [["dark", "teal"], ["light", "#3366ff"], ["dark", "#3366ff"]] as const) {
    localStorage.setItem("superagent2.theme", theme);
    localStorage.setItem("superagent2.accent", accent);
    window.dispatchEvent(new Event(appearanceEvent));
    expect(document.documentElement.dataset.theme).toBe(theme);
    for (const [name, value] of Object.entries(accentTokens(accent, theme))) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe(value);
    }
  }
});
