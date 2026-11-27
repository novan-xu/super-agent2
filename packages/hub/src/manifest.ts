import { text } from "@super-agent2/catalog";
import { createHash } from "node:crypto";
import { pageIconsPath } from "@super-agent2/protocol";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const manifestIcons = [
  { name: "icon-192.png", sizes: "192x192", purpose: "any" },
  { name: "icon-512.png", sizes: "512x512", purpose: "any" },
  { name: "icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
] as const;

export async function webManifest(iconDirectory: string): Promise<string> {
  const icons = await Promise.all(manifestIcons.map(async (icon) => {
    const bytes = await readFile(join(iconDirectory, icon.name));
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { src: `${pageIconsPath}${icon.name.replace(/\.png$/, `.${hash}.png`)}`, sizes: icon.sizes, type: "image/png", purpose: icon.purpose };
  }));
  return JSON.stringify({
    id: "/",
    name: text("app.name"),
    short_name: text("app.name"),
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#161514",
    theme_color: "#161514",
    icons,
  });
}
