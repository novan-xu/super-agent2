export const minPanelHeight = 260;
export const minCanvasHeight = 200;
const splitterHeight = 8;
const storageKey = "workbench.panelHeight";

export function panelHeightMaximum(layoutHeight: number): number {
  return Math.max(minPanelHeight, Math.floor(layoutHeight - minCanvasHeight - splitterHeight));
}

export function clampPanelHeight(height: number, maximum: number): number {
  return Math.min(Math.max(minPanelHeight, Math.round(height)), Math.max(minPanelHeight, maximum));
}

export function parsePanelHeight(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const height = Number(value);
  return Number.isFinite(height) && height >= minPanelHeight ? height : null;
}

export function loadPanelHeight(): number | null {
  try { return parsePanelHeight(localStorage.getItem(storageKey)); } catch { return null; }
}

export function savePanelHeight(height: number | null): void {
  try {
    if (height === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(height));
  } catch {}
}
