import { accentColor, accentKey, accentTokens, appearanceEvent, attributesOf, concernsAppearance, themeKey } from "./appearance.js";

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
  root.dataset["accent"] = attributes.accent;
  for (const [name, value] of Object.entries(accentTokens(attributes.accent, attributes.theme))) {
    root.style.setProperty(name, value);
  }
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) {
    const color = accentColor(attributes.accent);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#ffffff" stroke="#dddddd" stroke-width=".3"/><g transform="translate(2.16 2.16) scale(.82)"><circle cx="12" cy="12" r="3.3" fill="#1a1917"/><path d="M19.24 10.06A7.5 7.5 0 1 1 13.94 4.76" fill="none" stroke="#1a1917" stroke-width="2" stroke-linecap="round"/><circle cx="17.4" cy="6.6" r="2.1" fill="${color}"/></g></svg>`;
    icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
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
