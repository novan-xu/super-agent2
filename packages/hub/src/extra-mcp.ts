import { ExtraMcpServer } from "@super-agent2/protocol";
import { z } from "zod";

const Definition = ExtraMcpServer.omit({ token: true }).extend({
  secret: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  brain: z.boolean(),
  workers: z.boolean(),
});

export function extraMcpFromEnvironment(environment: Readonly<Record<string, string | undefined>>): { brain: ExtraMcpServer[]; workers: ExtraMcpServer[] } {
  const raw = environment["HUB_EXTRA_MCP_SERVERS"];
  if (raw === undefined || raw === "") return { brain: [], workers: [] };
  let definitions: z.infer<typeof Definition>[];
  try {
    definitions = z.array(Definition).parse(JSON.parse(raw));
  } catch {
    throw new Error("HUB_EXTRA_MCP_SERVERS must be a JSON array of valid MCP server definitions");
  }
  if (new Set(definitions.map((entry) => entry.name)).size !== definitions.length) throw new Error("HUB_EXTRA_MCP_SERVERS contains duplicate names");
  const brain: ExtraMcpServer[] = [];
  const workers: ExtraMcpServer[] = [];
  for (const definition of definitions) {
    const token = environment[definition.secret];
    if (token === undefined || token === "") throw new Error(`Missing MCP secret ${definition.secret}`);
    const server = { name: definition.name, url: definition.url, token };
    if (definition.brain) brain.push(server);
    if (definition.workers) workers.push(server);
  }
  return { brain, workers };
}
