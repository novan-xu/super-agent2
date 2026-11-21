import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtraMcpServer } from "@super-agent2/protocol";
import { extraMcpVariable } from "./settings.js";

const bridge = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./mcp-stdio.ts" : "./mcp-stdio.js", import.meta.url));

export function antigravityMcp(servers: readonly ExtraMcpServer[]) {
  const directory = mkdtempSync(join(tmpdir(), "superagent2-agy-mcp-"));
  const close = () => rmSync(directory, { recursive: true, force: true });
  try {
    const mcpServers = Object.fromEntries(servers.map((server, index) => [
      server.name,
      { command: process.execPath, args: [bridge, server.url, extraMcpVariable(index)] },
    ]));
    const config = join(directory, ".agents");
    mkdirSync(config);
    writeFileSync(join(config, "mcp_config.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
    const settings = { permissions: { allow: servers.map((server) => `mcp(${server.name}/*)`) } };
    return {
      args: ["--add-dir", realpathSync(directory), "--settings", JSON.stringify(settings)],
      environment: Object.fromEntries(servers.map((server, index) => [extraMcpVariable(index), server.token])),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
