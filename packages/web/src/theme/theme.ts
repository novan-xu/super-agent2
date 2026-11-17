import { accentKey, appearanceEvent, attributesOf, concernsAppearance, themeKey } from "./appearance.js";

const light = window.matchMedia("(prefers-color-scheme: light)");

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function apply(): void {
  const attributes = attributesOf(stored(themeKey), stored(accentKey), light.matches);
  const root = document.documentElement;
  root.dataset["theme"] = attributes.theme;
  if (attributes.accent === null) {
    delete root.dataset["accent"];
  } else {
    root.dataset["accent"] = attributes.accent;
  }
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", attributes.color);
  }
}

apply();
light.addEventListener("change", apply);
window.addEventListener("storage", (event) => {
  if (concernsAppearance(event.key)) {
    apply();
  }
});
window.addEventListener(appearanceEvent, apply);
