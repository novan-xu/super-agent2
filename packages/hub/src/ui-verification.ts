import { type ScreenshotSet, screenshotWidths, uiConfigFile } from "@super-agent2/protocol";
import picomatch from "picomatch";
import { z } from "zod";
import type { ChangedFile } from "./github-api.js";

const UiConfig = z.strictObject({
  paths: z.array(z.string().trim().min(1).max(240).refine((path) => !/[\\\u0000-\u001f]/u.test(path)
    && !path.startsWith("/") && !path.split("/").some((part) => part === "." || part === ".." || part === ""))).min(1).max(100),
});

export function uiPaths(content: string): readonly string[] | undefined {
  try {
    return UiConfig.parse(JSON.parse(content)).paths;
  } catch {
    return undefined;
  }
}

export function touchesUi(files: readonly ChangedFile[], paths: readonly string[]): boolean {
  const matches = picomatch([...paths], { dot: true, nonegate: true, windows: false });
  return files.some(({ path, previous }) => matches(path) || (previous !== null && matches(previous)));
}

export const invalidUiConfig = `${uiConfigFile} must be a JSON object with a nonempty "paths" list of repository-relative glob patterns.`;

export function screenshotProblem(head: string, screenshots: ScreenshotSet | undefined): string | undefined {
  if (screenshots === undefined || screenshots.images.length === 0) {
    return "Hand in after screenshots at phone (390 px) and desktop (1440 px) widths.";
  }
  if (screenshots.head !== head) {
    return `The screenshots were handed in for ${screenshots.head.slice(0, 7)}. Capture and hand them in for the current head ${head.slice(0, 7)}.`;
  }
  const images = new Map<string, Set<string>>();
  const afterWidths = new Set<string>();
  for (const { view, width, phase } of screenshots.images) {
    const key = `${view} (${width})`;
    const phases = images.get(key) ?? new Set<string>();
    if (phases.has(phase)) return `Hand in only one ${phase} screenshot for ${key}.`;
    phases.add(phase);
    images.set(key, phases);
    if (phase === "after") afterWidths.add(width);
  }
  const missing = screenshotWidths.filter((width) => !afterWidths.has(width));
  if (missing.length > 0) return `Add the missing after screenshot at ${missing.join(" and ")} width.`;
  const newViews = new Set(screenshots.newViews);
  for (const [key, phases] of images) {
    if (!phases.has("after")) return `Add the matching after screenshot for ${key}.`;
  }
  for (const { view, width, phase } of screenshots.images) {
    const key = `${view} (${width})`;
    if (phase === "after" && !newViews.has(view) && !images.get(key)?.has("before")) {
      return `Add the before screenshot for ${key}, or list "${view}" in newViews if that view is new.`;
    }
  }
  return undefined;
}
