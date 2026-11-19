export const defaultPanelWidth = 380;
export const minPanelWidth = 300;
export const minCanvasWidth = 260;
export const splitterWidth = 8;
const storageKey = "workbench.panelWidth";

export function panelMaximum(layoutWidth: number, railWidth: number): number {
  return Math.max(minPanelWidth, Math.floor(layoutWidth - railWidth - minCanvasWidth - splitterWidth));
}

export function clampPanelWidth(width: number, maximum: number): number {
  return Math.min(Math.max(minPanelWidth, Math.round(width)), Math.max(minPanelWidth, maximum));
}

export function parsePanelWidth(value: string | null): number {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return defaultPanelWidth;
  const width = Number(value);
  return Number.isFinite(width) && width >= minPanelWidth ? width : defaultPanelWidth;
}

export function loadPanelWidth(): number {
  try { return parsePanelWidth(localStorage.getItem(storageKey)); } catch { return defaultPanelWidth; }
}

export function savePanelWidth(width: number): void {
  try { localStorage.setItem(storageKey, String(width)); } catch {}
}
