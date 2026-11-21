import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest, isJSONRPCRequest, isJSONRPCResultResponse, type RequestId } from "@modelcontextprotocol/sdk/types.js";

async function bridge(): Promise<void> {
  const [, , url, variable] = process.argv;
  const token = variable === undefined ? undefined : process.env[variable];
  if (url === undefined || !token) throw new Error("Missing MCP endpoint or token");

  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  let initialize: RequestId | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([stdio.close(), http.close()]);
  };
  process.stdin.once("end", () => void close());
  process.stdout.once("error", () => void close());

  http.onmessage = (message) => {
    if (initialize !== undefined && isJSONRPCResultResponse(message) && message.id === initialize) {
      const version = message.result["protocolVersion"];
      if (typeof version === "string") http.setProtocolVersion(version);
      initialize = undefined;
    }
    if (!closed) void stdio.send(message).catch(close);
  };
  stdio.onmessage = (message) => {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) initialize = message.id;
    void http.send(message).catch(async () => {
      if (!closed && isJSONRPCRequest(message)) {
        await stdio.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "The configured HTTP MCP server could not answer." } });
      }
    }).catch(close);
  };
  await http.start();
  await stdio.start();
}

await bridge().catch(() => {
  console.error("Could not start the HTTP MCP bridge.");
  process.exitCode = 1;
});
