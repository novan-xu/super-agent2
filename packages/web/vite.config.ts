import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), { name: "pdf-assets", closeBundle() {
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
