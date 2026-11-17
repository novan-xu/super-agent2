import react from "@vitejs/plugin-react";
import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const conditions = { client: ["source", ...defaultClientConditions], server: ["source", ...defaultServerConditions] };

export default defineConfig({
  resolve: { conditions: conditions.client },
  ssr: { resolve: { conditions: conditions.server } },
  test: {
    testTimeout: 0,
    hookTimeout: 0,
    projects: [
      { extends: true, test: { name: "catalog", root: "packages/catalog" } },
      { extends: true, test: { name: "protocol", root: "packages/protocol" } },
      { extends: true, test: { name: "hub", root: "packages/hub" } },
      { extends: true, test: { name: "programs", root: "packages/programs" } },
      { extends: true, test: { name: "brain", root: "packages/brain" } },
      { extends: true, test: { name: "runner", root: "packages/runner" } },
      { extends: true, plugins: [react()], test: { name: "web", root: "packages/web" } },
      { extends: true, test: { name: "markup-text", root: "tools/markup-text" } },
      { extends: true, test: { name: "zero-comment", root: "tools/zero-comment" } },
    ],
  },
});
