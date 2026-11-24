import { z } from "zod";

export const streamableMcpVersions = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const JsonRpcId = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

const JsonRpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
const InitializeParams = z.looseObject({ protocolVersion: z.string().optional() });
export const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

export type ToolReply =
  | { readonly status: 200; readonly body: Readonly<Record<string, unknown>> }
  | { readonly status: 202 }
  | { readonly status: 400; readonly body: Readonly<Record<string, unknown>> };

export function errorBody(id: JsonRpcId | null, code: number, message: string): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function resultBody(id: JsonRpcId, result: unknown): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, result };
}

export function handleMcp(body: string, server: {
  name: string;
  versions: readonly [string, ...string[]];
  list: () => readonly unknown[];
  call: (id: JsonRpcId, params: unknown) => ToolReply | Promise<ToolReply>;
}): ToolReply | Promise<ToolReply> {
  let message: z.infer<typeof JsonRpcMessage>;
  try {
    const parsed = JsonRpcMessage.safeParse(JSON.parse(body));
    if (!parsed.success) return { status: 400, body: errorBody(null, -32600, "Invalid request") };
    message = parsed.data;
  } catch {
    return { status: 400, body: errorBody(null, -32700, "Parse error") };
  }
  const { id, method } = message;
  if (id === undefined || method === undefined) return { status: 202 };
  switch (method) {
    case "initialize": {
      const requested = InitializeParams.safeParse(message.params).data?.protocolVersion;
      return { status: 200, body: resultBody(id, {
        protocolVersion: server.versions.find((known) => known === requested) ?? server.versions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: "0.0.0" },
      }) };
    }
    case "ping": return { status: 200, body: resultBody(id, {}) };
    case "tools/list": return { status: 200, body: resultBody(id, { tools: server.list() }) };
    case "tools/call": return server.call(id, message.params);
    default: return { status: 200, body: errorBody(id, -32601, `Method not found: ${method}`) };
  }
}
