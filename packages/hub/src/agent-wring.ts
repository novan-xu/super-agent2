import { TEXT_BYTES, canDrawBytes } from "@super-agent2/catalog";
import { DeliveryFileName, type DeliveredFile, type ExtraMcpServer, type Ticket } from "@super-agent2/protocol";
import { setTimeout } from "node:timers/promises";

export function isAgentWringWriting(ticket: Pick<Ticket, "light" | "kind">): boolean {
  return ticket.light === "agent_wring" && ticket.kind === "writing";
}

type WriteArticle = (offset: number, bytes: Buffer) => void;

export function articleName(header: string | null, product: string): string {
  const fallback = `${product}.html`;
  if (header === null) return fallback;
  const parameters = new Map<string, string>();
  const pattern = /;\s*([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\[\x20-\x7e])*)"|([^;\s]*))/g;
  for (const match of header.matchAll(pattern)) {
    const key = match[1]!.toLowerCase();
    if (parameters.has(key)) return fallback;
    parameters.set(key, match[2] === undefined ? match[3]! : match[2].replace(/\\([\x20-\x7e])/g, "$1"));
  }
  let name: string | undefined;
  const extended = parameters.get("filename*");
  if (extended !== undefined) {
    const match = /^UTF-8'[^']*'([!#$&+.^_`|~\w%-]*)$/i.exec(extended);
    if (match !== null) {
      try { name = decodeURIComponent(match[1]!); } catch { name = undefined; }
    }
  }
  name ??= parameters.get("filename");
  if (name === undefined || !/\.html$/i.test(name) || /[\u007f-\u009f]/u.test(name) || !DeliveryFileName.safeParse(name).success) return fallback;
  return name;
}

export function uniqueArticleName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name; }
  const stem = name.slice(0, -5);
  for (let index = 2; ; index++) {
    const suffix = ` (${index})${name.slice(-5)}`;
    const candidate = `${Array.from(stem).slice(0, 120 - suffix.length).join("")}${suffix}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

async function download(url: URL, token: string, signal: AbortSignal, write: WriteArticle): Promise<{ size: number; disposition: string | null }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal });
  } catch {
    throw new Error("the server could not be reached");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!response.ok || contentType !== "text/html" || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new Error("HTTP 404, the saved HTML product was not found");
    if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}, the server refused the configured bearer token`);
    if (!response.ok) throw new Error(`the server returned HTTP ${response.status}`);
    throw new Error("the server did not return an HTML body");
  }
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    if (!canDrawBytes(size + chunk.length)) throw new Error(`the HTML exceeds the ${TEXT_BYTES / (1024 * 1024)} MiB preview limit`);
    write(size, Buffer.from(chunk));
    size += chunk.length;
  }
  if (size === 0) throw new Error("the server returned an empty HTML body");
  return { size, disposition: response.headers.get("content-disposition") };
}

export async function fetchArticle(server: ExtraMcpServer, product: string, stopped: AbortSignal, write: WriteArticle): Promise<DeliveredFile> {
  const url = new URL(server.url);
  if (!/\/mcp\/?$/.test(url.pathname)) throw new Error("The Agent_wring MCP URL must end in /mcp to fetch articles.");
  url.pathname = url.pathname.replace(/\/mcp\/?$/, `/products/${product}/article.html`);
  let problem = "no response";
  for (const delay of [0, 250, 500]) {
    if (delay > 0) await setTimeout(delay, undefined, { signal: stopped });
    stopped.throwIfAborted();
    const timeout = AbortSignal.timeout(15_000);
    try {
      const { size, disposition } = await download(url, server.token, AbortSignal.any([stopped, timeout]), write);
      return { name: articleName(disposition, product), size, mediaType: "text/html; charset=utf-8" };
    } catch (error) {
      stopped.throwIfAborted();
      problem = timeout.aborted ? "the request timed out" : error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Agent_wring article ${product} could not be fetched: ${problem}.`);
}
