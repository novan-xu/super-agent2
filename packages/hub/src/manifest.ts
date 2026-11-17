import { text } from "@super-agent2/catalog";
import { pageIconsPath } from "@super-agent2/protocol";

export const manifestIcons = [
  { name: "icon-192.png", sizes: "192x192", purpose: "any" },
  { name: "icon-512.png", sizes: "512x512", purpose: "any" },
  { name: "icon-512.png", sizes: "512x512", purpose: "maskable" },
] as const;

export function webManifest(): string {
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
    icons: manifestIcons.map((icon) => ({
      src: `${pageIconsPath}${icon.name}`,
      sizes: icon.sizes,
      type: "image/png",
      purpose: icon.purpose,
    })),
  });
}
