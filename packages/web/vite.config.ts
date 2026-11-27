import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), { name: "versioned-icons", closeBundle() {
    const icons = ["apple-touch-icon.png", "mark.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
    const urls = new Map<string, string>();
    for (const name of icons) {
      const source = `dist/icons/${name}`;
      const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
      const versioned = name.replace(/\.(png|svg)$/, `.${hash}.$1`);
      copyFileSync(source, `dist/icons/${versioned}`);
      urls.set(name, `/icons/${versioned}`);
    }
    const htmlPath = "dist/index.html";
    let html = readFileSync(htmlPath, "utf8");
    for (const name of icons) html = html.replaceAll(`/icons/${name}`, urls.get(name)!);
    for (const [name, url] of urls) {
      const match = /^\/icons\/(.+)\.([a-f0-9]{64})\.(png|svg)$/.exec(url);
      if (match === null) throw new Error(`Icon URL is not versioned: ${url}`);
      const bytes = readFileSync(`dist/icons/${match[1]}.${match[2]}.${match[3]}`);
      const htmlReferenceRequired = name === "apple-touch-icon.png" || name === "mark.svg";
      if (createHash("sha256").update(bytes).digest("hex") !== match[2] || (htmlReferenceRequired && !html.includes(url))) throw new Error(`Icon URL does not match its content or HTML reference: ${url}`);
    }
    writeFileSync(htmlPath, html);
    const workerPath = "dist/sw.js";
    writeFileSync(workerPath, readFileSync(workerPath, "utf8").replaceAll("/icons/icon-192.png", urls.get("icon-192.png")!));
  } }, { name: "pdf-assets", closeBundle() {
    const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    mkdirSync("dist/pdfjs", { recursive: true });
    for (const folder of ["cmaps", "standard_fonts"]) cpSync(join(root, folder), join("dist/pdfjs", folder), { recursive: true });
  } }],
  experimental: { renderBuiltUrl: (_filename, { hostType }) => hostType === "js" ? { relative: true } : undefined },
  build: {
    rollupOptions: {
      input: { index: "index.html", sw: "src/worker/sw.ts", theme: "src/theme/theme.ts" },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : chunk.name === "theme" ? "theme.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
