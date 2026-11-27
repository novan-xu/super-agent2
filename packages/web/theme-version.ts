import { createHash } from "node:crypto";

export function versionThemeScript(html: string, script: Uint8Array): string {
  const hash = createHash("sha256").update(script).digest("hex");
  const source = 'src="/theme.js"';
  if (!html.includes(source)) throw new Error("Theme script reference is missing");
  return html.replace(source, `src="/theme.js?v=${hash}"`);
}
