import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { index: "index.html", sw: "src/worker/sw.ts", theme: "src/theme/theme.ts" },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : chunk.name === "theme" ? "theme.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
