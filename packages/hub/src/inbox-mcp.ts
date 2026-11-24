import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { isJson, readBody } from "./http-json.js";
import type { Inbox } from "./inbox.js";
import { inboxMcpBodyBytes, inboxTransferDefinitions, InboxTransferError } from "./inbox-transfers.js";
import { CallParams, errorBody, handleMcp, resultBody, streamableMcpVersions } from "./mcp.js";
import type { PushService } from "./push-service.js";

export async function serveInboxMcp(options: {
  request: IncomingMessage;
  response: ServerResponse;
  inbox: Inbox;
  clientId: string;
  allowedOrigin: boolean;
  changed: () => void;
  push?: PushService | undefined;
}): Promise<void> {
  const { request, response, inbox, clientId } = options;
  const reply = (status: number, body?: Readonly<Record<string, unknown>>) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (body !== undefined) response.setHeader("content-type", "application/json; charset=utf-8");
    response.writeHead(status);
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (!options.allowedOrigin || inbox.sourceFor(clientId) === undefined) {
    request.resume();
    reply(403, errorBody(null, -32000, "Forbidden"));
    return;
  }
  if (request.method !== "POST") {
    request.resume();
    response.setHeader("allow", "POST");
    reply(405);
    return;
  }
  if (!isJson(request)) {
    request.resume();
    reply(415, errorBody(null, -32000, "Send application/json."));
    return;
  }
  const version = request.headers["mcp-protocol-version"];
  if (version !== undefined && !streamableMcpVersions.some((supported) => supported === version)) {
    request.resume();
    reply(400, errorBody(null, -32000, "Unsupported MCP protocol version. Send initialize to negotiate a supported version."));
    return;
  }
  const raw = Number(request.headers["content-length"] ?? 0) > inboxMcpBodyBytes ? undefined : await readBody(request, inboxMcpBodyBytes);
  if (raw === undefined) {
    request.resume();
    reply(413, errorBody(null, -32000, "Request is too large. Send parts of up to 8 MiB before base64 encoding."));
    return;
  }
  const source = inbox.sourceFor(clientId);
  if (source === undefined) {
    reply(403, errorBody(null, -32000, "Forbidden"));
    return;
  }
  const result = await handleMcp(raw, {
    name: "super-agent-inbox",
    versions: streamableMcpVersions,
    list: () => inboxTransferDefinitions,
    call: async (id, params) => {
      const parsed = CallParams.safeParse(params);
      if (!parsed.success) return { status: 200, body: errorBody(id, -32602, "Invalid tool call") };
      try {
        const result = await inbox.transfer(source, parsed.data.name, parsed.data.arguments ?? {});
        if (result.published !== undefined) {
          options.changed();
          options.push?.transfer(source.name, result.published.files, result.published.entry_id);
        }
        return { status: 200, body: resultBody(id, { content: [{ type: "text", text: JSON.stringify(result.data) }] }) };
      } catch (error) {
        const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof InboxTransferError ? error.message : undefined;
        if (message === undefined) throw error;
        return { status: 200, body: resultBody(id, { isError: true, content: [{ type: "text", text: message }] }) };
      }
    },
  });
  reply(result.status, "body" in result ? result.body : undefined);
}
