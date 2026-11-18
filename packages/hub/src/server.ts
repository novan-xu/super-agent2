import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Duplex, Readable } from "node:stream";
import {
  type AllowanceList,
  BrainMessage,
  brainLinkPath,
  ChainChoice,
  ChainStart,
  ChoiceChange,
  EngineTableBody,
  brainToolsPath,
  ClientMessage,
  conversationHeader,
  turnHeader,
  ConversationId,
  DecisionReview,
  type ConversationDetail,
  type ConversationList,
  type ConversationResponse,
  type EntryResponse,
  type StreamEntry,
  StreamMessage,
  type StreamPage,
  streamLargestPage,
  streamPageSize,
  streamPath,
  topicInScope,
  type TopicScope,
  type CommandList,
  type CommandResponse,
  type Health,
  HoldDecision,
  type HoldList,
  type Identity,
  type OutputResponse,
  PushRemoval,
  type PushKey,
  type PushState,
  PushSubscriptionRequest,
  type Refusal,
  type ServerMessage,
  type Session,
  type WaitingList,
  attachmentsPath,
  type MachineList,
  type TicketDetail,
  type TicketList,
  type TicketResponse,
  type WorkEventList,
  type WorkerMessageResponse,
  WorkerMessage,
  historyLargestPage,
  historyPageSize,
  historyQueryLength,
  type MemoryList,
  largestMessageBytes,
  MemoryText,
  positionOfCursor,
  protocolVersion,
  releaseVersionHeader,
  RepositoryName,
  runnerInstallPath,
  runnerLinkPath,
  runnerReleasePath,
  RunnerToHub,
  runnerTokenHeader,
  StuckAnswerRequest,
  MachineAddRequest,
  type MachineAdded,
  type MachineRevoked,
  MachineName,
  ProviderOrderChange,
  RepositoryAccountChange,
  type SettingsSnapshot,
} from "@super-agent2/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { type AccessVerifier, type Admission, assertionHeader } from "./access.js";
import type { BrainTokenCheck } from "./brain-token.js";
import type { ChainStarter, StartError, StartOutcome } from "./chains.js";
import type { StartDefaults } from "./defaults.js";
import type { CommandService } from "./commands.js";
import type { ConversationService } from "./conversations.js";
import type { HubDatabase } from "./database.js";
import type { FailureLoop, StuckAnswerError } from "./failure-loop.js";
import type { DecisionReviews } from "./reviews.js";
import type { TicketFiles } from "./files.js";
import type { AttachmentStore, ChosenAttachments } from "./attachments.js";
import { serveAttachments } from "./attachments-api.js";
import type { AnswerError, ConfirmationLock } from "./lock.js";
import { type PageFiles, pageSecurityHeaders } from "./page.js";
import type { PushService } from "./push-service.js";
import type { Machine } from "./machines.js";
import type { MemoryService, OwnerMemoryError } from "./memories.js";
import type { ReleaseSource } from "./release.js";
import type { Runners } from "./runners.js";
import type { TicketService } from "./tickets.js";
import type { WorkService } from "./work.js";
import { text } from "@super-agent2/catalog";
import type { ToolServer } from "./tools.js";
import type { Waiting } from "./waiting.js";
import type { MachineAdmin } from "./machine-admin.js";
import type { RepositoryAccounts } from "./repositories.js";
import type { Settings } from "./settings.js";

export const healthPath = "/health";
export const sessionPath = "/api/session";
export const socketPath = "/ws";
export const commandsPath = "/api/commands";
export const holdsPath = "/api/holds";
export const conversationsPath = "/api/conversations";
export const waitingPath = "/api/waiting";
export const pushPath = "/api/push";
export const pushSubscriptionPath = "/api/push/subscription";
export const machinesPath = "/api/machines";
export const ticketsPath = "/api/tickets";
export const chainStartPath = "/api/chains/start";
export const chainChoicePath = "/api/chains/choice";
export const engineTablePath = "/api/engine-table";
export const allowancePath = "/api/allowance";
export const memoriesPath = "/api/memories";
export const settingsPath = "/api/settings";
export const brainOrderPath = "/api/brain/order";
export const repositoryAccountPath = "/api/repositories/account";

const revokeRoute = /^\/api\/machines\/([^/]{1,63})\/revoke$/;

const memoryRoute = /^\/api\/memories\/([1-9][0-9]{0,15})$/;

const suggestionRoute = /^\/api\/memories\/suggestions\/([1-9][0-9]{0,15})\/(confirm|decline)$/;

const memoryStatus: Readonly<Record<OwnerMemoryError, number>> = {
  not_found: 404,
  bad_request: 400,
};

const reassignRoute = /^\/api\/tickets\/([1-9][0-9]{0,15})\/reassign$/;

const startStatus: Readonly<Record<StartError, number>> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  incomplete: 409,
  unsupported: 422,
};

const ticketRoute = /^\/api\/tickets\/([1-9][0-9]{0,15})$/;

const ticketFileRoute = /^\/api\/tickets\/([1-9][0-9]{0,15})\/files\/([^/]{1,400})$/;

const ticketDecisionRoute = /^\/api\/tickets\/([1-9][0-9]{0,15})\/decisions\/([1-9][0-9]{0,15})$/;

const ticketWorkRoute = /^\/api\/tickets\/([1-9][0-9]{0,15})\/(work|messages|stop|answer)$/;

const stuckAnswerStatus: Readonly<Record<StuckAnswerError, number>> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

const maximumWorkEvents = 5_000;

export const ownerStopReason = { en: "The owner stopped it", zh: text("ticket.reason.ownerStopped") };

const commandRoute = /^\/api\/commands\/([0-9A-Za-z-]+)(\/output|\/stop|\/release|\/refuse)?$/;

const conversationRoute = /^\/api\/conversations\/([0-9A-Za-z-]+)(\/messages|\/interrupt)?$/;

const defaultListLimit = 50;
const maximumListLimit = 500;

export interface HubServerOptions {
  readonly database: HubDatabase;
  readonly commands: CommandService;
  readonly verify: AccessVerifier;
  readonly verifyRunner?: AccessVerifier;
  readonly admit: Admission;
  readonly lock?: ConfirmationLock;
  readonly conversations?: ConversationService;
  readonly tools?: ToolServer;
  readonly brainToken?: BrainTokenCheck;
  readonly page?: PageFiles;
  readonly waiting?: Waiting;
  readonly push?: PushService;
  readonly runners?: Runners;
  readonly tickets?: TicketService;
  readonly files?: TicketFiles;
  readonly attachments?: AttachmentStore;
  readonly work?: WorkService;
  readonly chains?: ChainStarter;
  readonly loop?: FailureLoop;
  readonly reviews?: DecisionReviews;
  readonly defaults?: StartDefaults;
  readonly heartbeatMilliseconds?: number;
  readonly version?: string;
  readonly release?: ReleaseSource;
  readonly memories?: MemoryService;
  readonly settings?: Settings;
  readonly admin?: MachineAdmin;
  readonly repositories?: RepositoryAccounts;
}

export interface HubServer {
  readonly server: Server;
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

function headerValue(request: IncomingMessage): string | undefined {
  const value = request.headers[assertionHeader];
  return Array.isArray(value) ? undefined : value;
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://hub").pathname;
}

type Body =
  | Health
  | Refusal
  | Session
  | CommandList
  | CommandResponse
  | OutputResponse
  | HoldList
  | ConversationList
  | ConversationResponse
  | ConversationDetail
  | StreamEntry
  | StreamPage
  | EntryResponse
  | WaitingList
  | PushKey
  | PushState
  | MachineList
  | TicketList
  | TicketDetail
  | TicketResponse
  | WorkEventList
  | WorkerMessageResponse
  | EngineTableBody
  | AllowanceList
  | { readonly requested: number }
  | MemoryList
  | SettingsSnapshot
  | MachineAdded
  | MachineRevoked;

function sendJson(response: ServerResponse, status: number, body: Body, headOnly = false): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : text);
}

function integerParameter(url: URL, name: string, fallback: number, maximum: number): number | undefined {
  const text = url.searchParams.get(name);
  if (text === null) {
    return fallback;
  }
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  return Math.min(Number(text), maximum);
}

function isJson(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function withoutDefaultPort(host: string): string {
  return host.toLowerCase().replace(/:(?:80|443)$/, "");
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  const site = request.headers["sec-fetch-site"];
  if (typeof origin !== "string" || host === undefined || (site !== undefined && site !== "same-origin")) {
    return false;
  }
  try {
    return withoutDefaultPort(new URL(origin).host) === withoutDefaultPort(host);
  } catch {
    return false;
  }
}

function declaresTooLarge(request: IncomingMessage): boolean {
  const declared = Number(request.headers["content-length"] ?? "0");
  return Number.isFinite(declared) && declared > largestMessageBytes;
}

function refuseTooLarge(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  response.setHeader("connection", "close");
  sendJson(response, 413, { error: "too_large" });
}

function readBody(request: IncomingMessage, limit: number = largestMessageBytes): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(undefined));
  });
}

function parseDecision(text: string | undefined): HoldDecision | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = HoldDecision.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseJson<Schema extends z.ZodType>(text: string | undefined, schema: Schema): z.output<Schema> | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const answerStatus: Readonly<Record<AnswerError, 403 | 404 | 409>> = { forbidden: 403, not_found: 404, conflict: 409 };

function parseOwnerMessage(text: string | undefined): StreamMessage | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = StreamMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sendRaw(response: ServerResponse, status: number, body?: Readonly<Record<string, unknown>>): void {
  if (body === undefined) {
    response.writeHead(status, { "content-length": 0, "cache-control": "no-store" });
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function brainAuthorization(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === "string" ? value : undefined;
}

function isBrainPath(path: string): boolean {
  return path.startsWith("/brain/");
}

function isRunnerPath(path: string): boolean {
  return path.startsWith("/runner/");
}

function runnerToken(request: IncomingMessage): string | undefined {
  const value = request.headers[runnerTokenHeader];
  return typeof value === "string" ? value : undefined;
}

function refuseSocket(socket: Duplex, status: 403 | 404): void {
  const reason = status === 403 ? "Forbidden" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHubServer(options: HubServerOptions): HubServer {
  const sockets = new WebSocketServer({ noServer: true });

  const authenticate = async (request: IncomingMessage): Promise<Identity | undefined> => {
    try {
      const result = await options.verify(headerValue(request));
      if (!result.ok || !options.admit(result.identity)) {
        return undefined;
      }
      return result.identity;
    } catch {
      return undefined;
    }
  };

  const isBrain = (request: IncomingMessage): boolean => options.brainToken?.(brainAuthorization(request)) ?? false;

  const runnerMachine = async (request: IncomingMessage): Promise<Machine | undefined> => {
    const runners = options.runners;
    if (runners === undefined) {
      return undefined;
    }
    try {
      const result = await (options.verifyRunner ?? options.verify)(headerValue(request));
      return result.ok ? runners.admit(result.identity, runnerToken(request)) : undefined;
    } catch {
      return undefined;
    }
  };

  const serveTools = async (request: IncomingMessage, response: ServerResponse, method: string): Promise<void> => {
    const tools = options.tools;
    if (tools === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (method !== "POST") {
      request.resume();
      response.writeHead(405, { allow: "POST", "content-length": 0 });
      response.end();
      return;
    }
    if (!isJson(request)) {
      request.resume();
      sendJson(response, 415, { error: "unsupported_media_type" });
      return;
    }
    if (declaresTooLarge(request)) {
      refuseTooLarge(request, response);
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    const header = request.headers[conversationHeader];
    const conversation = typeof header === "string" && ConversationId.safeParse(header).success ? header : undefined;
    const turnId = request.headers[turnHeader];
    const turn = typeof turnId === "string" && turnId !== "" ? turnId : undefined;
    const aborted = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        aborted.abort();
      }
    });
    const reply = await tools.handle({ body, conversation, turn, aborted: aborted.signal });
    if (aborted.signal.aborted) {
      return;
    }
    sendRaw(response, reply.status, reply.status === 202 ? undefined : reply.body);
  };

  const serveRelease = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    request.resume();
    const machine = await runnerMachine(request);
    if (machine === undefined) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    const release = options.release;
    if (release === undefined) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const download = await release.open();
    if (!download.ok) {
      sendJson(response, 503, { error: "unavailable" });
      return;
    }
    response.writeHead(200, { "content-type": "application/gzip", "cache-control": "no-store", [releaseVersionHeader]: release.version });
    const body = Readable.fromWeb(download.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("error", () => response.destroy());
    response.on("close", () => body.destroy());
    body.pipe(response);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = pathOf(request);
    const method = request.method ?? "GET";
    if (path === healthPath && (method === "GET" || method === "HEAD")) {
      const healthy = options.database.healthy();
      sendJson(response, healthy ? 200 : 503, { status: healthy ? "ok" : "unavailable", ...(options.version === undefined ? {} : { version: options.version }) }, method === "HEAD");
      return;
    }
    if (isBrainPath(path)) {
      if (!isBrain(request)) {
        request.resume();
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      if (path === brainToolsPath) {
        await serveTools(request, response, method);
        return;
      }
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (path === runnerInstallPath && method === "GET") {
      await serveInstall(request, response);
      return;
    }
    if (path === runnerReleasePath && method === "GET") {
      await serveRelease(request, response);
      return;
    }
    if (isRunnerPath(path)) {
      request.resume();
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    const identity = await authenticate(request);
    if (identity === undefined) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    if (declaresTooLarge(request)) {
      refuseTooLarge(request, response);
      return;
    }
    if (path === sessionPath && method === "GET") {
      sendJson(response, 200, { protocol: protocolVersion, identity });
      return;
    }
    if (path === holdsPath && method === "GET" && options.lock !== undefined) {
      const holds = options.lock.waiting().flatMap((hold) => {
        const command = options.commands.get(hold.command);
        return command === undefined ? [] : [{ command, hold }];
      });
      sendJson(response, 200, { holds });
      return;
    }
    if (path === settingsPath && method === "GET" && options.settings !== undefined) {
      sendJson(response, 200, options.settings.snapshot());
      return;
    }
    if ((path === machinesPath && method === "POST") || (revokeRoute.test(path) && method === "POST")) {
      await serveMachineChange(request, response, path);
      return;
    }
    if ((path === brainOrderPath || path === repositoryAccountPath) && method === "PUT") {
      await serveSettingChange(request, response, path);
      return;
    }
    if (path === machinesPath && method === "GET" && options.runners !== undefined) {
      sendJson(response, 200, { machines: options.runners.statuses() });
      return;
    }
    if (path === waitingPath && method === "GET" && options.waiting !== undefined) {
      sendJson(response, 200, { cards: options.waiting.cards() });
      return;
    }
    if (path.startsWith(pushPath) && (await servePush(request, response, path, method))) {
      return;
    }
    if (path.startsWith(commandsPath) && (await serveCommands(request, response, path, method))) {
      return;
    }
    if ((path === streamPath || path.startsWith(conversationsPath)) && (await serveConversations(request, response, path, method))) {
      return;
    }
    if (
      path.startsWith(attachmentsPath) &&
      options.attachments !== undefined &&
      (await serveAttachments({ request, response, path, method, store: options.attachments, sameOrigin: isSameOrigin(request), readBody: () => readBody(request) }))
    ) {
      return;
    }
    if (path.startsWith(ticketsPath) && serveTickets(request, response, path, method)) {
      return;
    }
    if (path.startsWith(ticketsPath) && (await serveTicketWork(request, response, path, method))) {
      return;
    }
    if (path.startsWith(ticketsPath) && (await serveDecisionReview(request, response, path, method))) {
      return;
    }
    if (path.startsWith(memoriesPath) && options.memories !== undefined && (await serveMemories(request, response, path, method, options.memories))) {
      return;
    }
    if (path === chainStartPath && method === "POST") {
      await startChains(request, response);
      return;
    }
    if (path === chainChoicePath && method === "POST") {
      await changeChoice(request, response, "choose");
      return;
    }
    const reassigned = reassignRoute.exec(path)?.[1];
    if (reassigned !== undefined && method === "POST") {
      await changeChoice(request, response, "reassign", Number(reassigned));
      return;
    }
    if ((path === engineTablePath || path === allowancePath) && options.defaults !== undefined && (await serveDefaults(request, response, path, method, options.defaults))) {
      return;
    }
    if ((method === "GET" || method === "HEAD") && (await servePage(response, path, method === "HEAD"))) {
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  };

  const serveInstall = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    request.resume();
    const machine = await runnerMachine(request);
    if (machine === undefined) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    const outcome = options.admin?.install(machine) ?? { ok: false as const, error: "not_found" as const };
    if (!outcome.ok) {
      sendJson(response, outcome.error === "not_found" ? 404 : 503, { error: outcome.error });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(outcome.script),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(outcome.script);
  };

  const serveMachineChange = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    const admin = options.admin;
    if (admin === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!ownerAction(request, response)) {
      return;
    }
    const body = await readBody(request);
    const revoked = revokeRoute.exec(path)?.[1];
    if (revoked !== undefined) {
      const name = MachineName.safeParse(revoked);
      if (!name.success || parseJson(body, z.object({}).strict()) === undefined) {
        sendJson(response, 400, { error: "bad_request" });
        return;
      }
      const outcome = await admin.revoke(name.data);
      if (!outcome.ok) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      options.waiting?.refresh();
      sendJson(response, 200, { name: name.data, accessToken: outcome.accessToken });
      return;
    }
    const given = parseJson(body, MachineAddRequest.strict());
    if (given === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    const outcome = await admin.add({ ...given, hub: new URL(String(request.headers.origin)).origin });
    if (!outcome.ok) {
      if (outcome.error === "cloudflare_refused") {
        sendJson(response, 502, { error: outcome.error, reason: outcome.reason });
        return;
      }
      const status = outcome.error === "conflict" ? 409 : outcome.error === "bad_request" ? 400 : 503;
      sendJson(response, status, { error: outcome.error });
      return;
    }
    sendJson(response, 201, { name: outcome.name, system: outcome.system, command: outcome.command });
  };

  const serveSettingChange = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    const settings = options.settings;
    if (settings === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!ownerAction(request, response)) {
      return;
    }
    const body = await readBody(request);
    if (path === brainOrderPath) {
      const given = parseJson(body, ProviderOrderChange.strict());
      if (given === undefined) {
        sendJson(response, 400, { error: "bad_request" });
        return;
      }
      settings.setOrder(given.order);
      sendJson(response, 200, settings.snapshot());
      return;
    }
    const given = parseJson(body, RepositoryAccountChange.strict());
    const repositories = options.repositories;
    if (given === undefined || repositories === undefined || !repositories.set(given.repository, given.account)) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    settings.changed();
    sendJson(response, 200, settings.snapshot());
  };

  const servePage = async (response: ServerResponse, path: string, headOnly: boolean): Promise<boolean> => {
    const file = await options.page?.(path);
    if (file === undefined) {
      return false;
    }
    response.writeHead(200, {
      ...pageSecurityHeaders,
      "content-type": file.type,
      "content-length": file.body.length,
      "cache-control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    response.end(headOnly ? undefined : file.body);
    return true;
  };

  const answer = async (request: IncomingMessage, response: ServerResponse, id: string, verdict: "release" | "refuse"): Promise<void> => {
    const lock = options.lock;
    if (lock === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isSameOrigin(request)) {
      request.resume();
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    if (!isJson(request)) {
      request.resume();
      sendJson(response, 415, { error: "unsupported_media_type" });
      return;
    }
    const decision = parseDecision(await readBody(request));
    if (decision === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    const given = { assertion: headerValue(request), fingerprint: decision.fingerprint };
    const outcome = verdict === "release" ? await lock.release(id, given) : await lock.refuse(id, given);
    if (!outcome.ok) {
      sendJson(response, answerStatus[outcome.error], { error: outcome.error });
      return;
    }
    options.waiting?.refresh();
    const command = options.commands.get(id);
    if (command === undefined) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    sendJson(response, 202, { command });
  };

  const startChains = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chains = options.chains;
    if (chains === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isSameOrigin(request)) {
      request.resume();
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    if (!isJson(request)) {
      request.resume();
      sendJson(response, 415, { error: "unsupported_media_type" });
      return;
    }
    const start = parseJson(await readBody(request), ChainStart);
    if (start === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    const outcome = await chains.start({ assertion: headerValue(request), chains: start.chains });
    if (!outcome.ok) {
      sendJson(response, outcome.error === "forbidden" ? 403 : 409, { error: outcome.error });
      return;
    }
    options.waiting?.refresh();
    sendJson(response, 202, { tickets: [...outcome.tickets] });
  };

  const chooseAttachments = (ids: readonly string[]): ChosenAttachments => {
    if (ids.length === 0) {
      return { ok: true, attachments: [] };
    }
    return options.attachments?.choose(ids) ?? { ok: false, reason: "There is no attachment store" };
  };

  const ownerAction = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!isSameOrigin(request)) {
      request.resume();
      sendJson(response, 403, { error: "forbidden" });
      return false;
    }
    if (!isJson(request)) {
      request.resume();
      sendJson(response, 415, { error: "unsupported_media_type" });
      return false;
    }
    return true;
  };

  const sendOutcome = (response: ServerResponse, outcome: StartOutcome): void => {
    if (outcome.ok) {
      options.waiting?.refresh();
      sendJson(response, 202, { tickets: [...outcome.tickets] });
      return;
    }
    sendJson(response, startStatus[outcome.error], { error: outcome.error });
  };

  const changeChoice = async (request: IncomingMessage, response: ServerResponse, action: "choose" | "reassign", ticket?: number): Promise<void> => {
    const chains = options.chains;
    if (chains === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!ownerAction(request, response)) {
      return;
    }
    const body = await readBody(request);
    if (action === "choose") {
      const given = parseJson(body, ChainChoice.strict());
      if (given === undefined) {
        sendJson(response, 400, { error: "bad_request" });
        return;
      }
      const { ticket: id, ...change } = given;
      sendOutcome(response, await chains.choose({ assertion: headerValue(request), ticket: id, change }));
      return;
    }
    const change = parseJson(body, ChoiceChange.strict());
    if (change === undefined || ticket === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    sendOutcome(response, await chains.reassign({ assertion: headerValue(request), ticket, change }));
  };

  const allowanceSnapshot = (defaults: StartDefaults) => {
    const subscriptions = defaults.subscriptions();
    const balance = defaults.balance();
    const unavailable = defaults.unavailable();
    const dsh = defaults.out().get("dsh");
    if (dsh !== undefined && !unavailable.some((mark) => mark.program === "dsh")) {
      unavailable.push({ program: "dsh", reason: dsh.reason, since: balance.readAt, until: dsh.until, given: dsh.given });
    }
    return { subscriptions: [subscriptions.codex, subscriptions.claude], balance, unavailable };
  };

  const serveDefaults = async (request: IncomingMessage, response: ServerResponse, path: string, method: string, defaults: StartDefaults): Promise<boolean> => {
    if (path === allowancePath) {
      if (method === "POST") {
        if (!ownerAction(request, response)) return true;
        if (parseJson(await readBody(request), z.object({}).strict()) === undefined) { sendJson(response, 400, { error: "bad_request" }); return true; }
        sendJson(response, 200, { requested: options.runners?.refreshAllowance() ?? 0 });
        return true;
      }
      if (method !== "GET") return false;
      sendJson(response, 200, allowanceSnapshot(defaults));
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, { table: defaults.table() });
      return true;
    }
    if (method !== "PUT") {
      return false;
    }
    if (!ownerAction(request, response)) {
      return true;
    }
    const given = parseJson(await readBody(request), EngineTableBody.strict());
    if (given === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return true;
    }
    if (options.settings !== undefined) {
      const outcome = options.settings.setTable(given.table);
      if (!outcome.ok) {
        sendJson(response, 422, { error: "unsupported" });
        return true;
      }
      options.waiting?.refresh();
      sendJson(response, 200, { table: outcome.table });
      return true;
    }
    const table = defaults.setTable(given.table);
    options.waiting?.refresh();
    sendJson(response, 200, { table });
    return true;
  };

  const serveMemories = async (request: IncomingMessage, response: ServerResponse, path: string, method: string, memories: MemoryService): Promise<boolean> => {
    if (path === memoriesPath && method === "GET") {
      sendJson(response, 200, memories.snapshot());
      return true;
    }
    const id = memoryRoute.exec(path)?.[1];
    const suggestion = suggestionRoute.exec(path);
    const act =
      path === memoriesPath && method === "POST"
        ? (body: string | undefined) => {
            const given = parseJson(body, MemoryText.strict());
            return given === undefined ? undefined : memories.add(given.text);
          }
        : id !== undefined && method === "PUT"
          ? (body: string | undefined) => {
              const given = parseJson(body, MemoryText.strict());
              return given === undefined ? undefined : memories.edit(Number(id), given.text);
            }
          : id !== undefined && method === "DELETE"
            ? (body: string | undefined) => (parseJson(body, z.object({}).strict()) === undefined ? undefined : memories.remove(Number(id)))
            : suggestion !== null && method === "POST"
              ? (body: string | undefined) =>
                  parseJson(body, z.object({}).strict()) === undefined
                    ? undefined
                    : suggestion[2] === "confirm"
                      ? memories.confirm(Number(suggestion[1]))
                      : memories.decline(Number(suggestion[1]))
              : undefined;
    if (act === undefined) {
      return false;
    }
    if (!ownerAction(request, response)) {
      return true;
    }
    const outcome = act(await readBody(request));
    if (outcome === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return true;
    }
    if (!outcome.ok) {
      sendJson(response, memoryStatus[outcome.error], { error: outcome.error });
      return true;
    }
    sendJson(response, 200, outcome.list);
    return true;
  };

  const servePush = async (request: IncomingMessage, response: ServerResponse, path: string, method: string): Promise<boolean> => {
    if (path === pushPath && method === "GET") {
      sendJson(response, 200, { publicKey: options.push?.publicKey ?? null });
      return true;
    }
    if (path !== pushSubscriptionPath || (method !== "POST" && method !== "DELETE")) {
      return false;
    }
    const push = options.push;
    if (push === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return true;
    }
    if (!isSameOrigin(request)) {
      request.resume();
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    if (!isJson(request)) {
      request.resume();
      sendJson(response, 415, { error: "unsupported_media_type" });
      return true;
    }
    const body = await readBody(request);
    if (method === "DELETE") {
      const removal = parseJson(body, PushRemoval);
      if (removal === undefined) {
        sendJson(response, 400, { error: "bad_request" });
        return true;
      }
      push.unsubscribe(removal.endpoint);
      options.settings?.changed();
      sendJson(response, 200, { subscribed: false });
      return true;
    }
    const subscription = parseJson(body, PushSubscriptionRequest);
    if (subscription === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return true;
    }
    const outcome = push.subscribe(subscription, new URL(String(request.headers.origin)).origin);
    if (outcome === "saved") {
      options.settings?.changed();
      sendJson(response, 200, { subscribed: true });
    } else {
      sendJson(response, outcome === "invalid" ? 400 : 409, { error: outcome === "invalid" ? "bad_request" : "conflict" });
    }
    return true;
  };

  const serveCommands = async (request: IncomingMessage, response: ServerResponse, path: string, method: string): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://hub");
    if (path === commandsPath && method === "GET") {
      const limit = integerParameter(url, "limit", defaultListLimit, maximumListLimit);
      if (limit === undefined) {
        return false;
      }
      sendJson(response, 200, { commands: options.commands.list(limit) });
      return true;
    }
    const match = commandRoute.exec(path);
    const id = match?.[1];
    if (match === null || id === undefined) {
      return false;
    }
    const action = match[2];
    const command = options.commands.get(id);
    if (command === undefined) {
      return false;
    }
    if (action === undefined && method === "GET") {
      sendJson(response, 200, { command });
      return true;
    }
    if (action === "/output" && method === "GET") {
      const after = integerParameter(url, "after", 0, Number.MAX_SAFE_INTEGER);
      if (after === undefined) {
        return false;
      }
      sendJson(response, 200, { chunks: options.commands.output(id, after) });
      return true;
    }
    if (action === "/stop" && method === "POST") {
      request.resume();
      if (!isJson(request)) {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return true;
      }
      const stopped = options.commands.stop(id) ?? command;
      sendJson(response, 202, { command: stopped });
      return true;
    }
    if ((action === "/release" || action === "/refuse") && method === "POST") {
      await answer(request, response, id, action === "/release" ? "release" : "refuse");
      return true;
    }
    return false;
  };

  const serveConversations = async (request: IncomingMessage, response: ServerResponse, path: string, method: string): Promise<boolean> => {
    const conversations = options.conversations;
    if (conversations === undefined) {
      return false;
    }
    const url = new URL(request.url ?? "/", "http://hub");
    if (path === streamPath && method === "GET") {
      const before = integerParameter(url, "before", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      const limit = integerParameter(url, "limit", streamPageSize, streamLargestPage);
      const filter = url.searchParams.get("repository");
      const repository = filter === null ? undefined : filter === "" ? null : filter;
      if (before === undefined || before === 0 || limit === undefined || limit === 0 || (typeof repository === "string" && !RepositoryName.safeParse(repository).success)) {
        sendJson(response, 400, { error: "bad_request" });
      } else {
        sendJson(response, 200, conversations.stream(before, limit, repository));
      }
      return true;
    }
    if (path === conversationsPath && method === "GET") {
      const all = url.searchParams.get("all") === "1";
      const limit = all ? Number.MAX_SAFE_INTEGER : integerParameter(url, "limit", defaultListLimit, maximumListLimit);
      if (limit === undefined) {
        return false;
      }
      sendJson(response, 200, {
        brain: { linked: conversations.linked() }, conversations: conversations.list(limit),
        ...(all ? { repositories: options.repositories?.list().map(({ repository }) => repository) ?? [] } : {}),
      });
      return true;
    }
    if (path === conversationsPath && method === "POST") {
      request.resume();
      if (!isJson(request)) {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return true;
      }
      sendJson(response, 201, { conversation: conversations.create() });
      return true;
    }
    const match = conversationRoute.exec(path);
    const id = match?.[1];
    if (path !== streamPath && (id === undefined || conversations.get(id) === undefined)) {
      return false;
    }
    const action = match?.[2];
    if (id !== undefined && action === undefined && method === "GET") {
      const detail = conversations.detail(id);
      if (detail === undefined) {
        return false;
      }
      sendJson(response, 200, detail);
      return true;
    }
    if ((path === streamPath || action === "/messages") && method === "POST") {
      if (!isJson(request)) {
        request.resume();
        sendJson(response, 415, { error: "unsupported_media_type" });
        return true;
      }
      const message = parseOwnerMessage(await readBody(request));
      if (message === undefined) {
        sendJson(response, 400, { error: "bad_request" });
        return true;
      }
      const chosen = chooseAttachments(message.attachments);
      if (!chosen.ok) {
        sendJson(response, 409, { error: "conflict" });
        return true;
      }
      if (id === undefined) {
        const item = await conversations.sendToStream(message.topic, message.text, chosen.attachments, message);
        if (item === undefined) {
          return false;
        }
        sendJson(response, 202, item);
      } else {
        const entry = conversations.send(id, message.text, chosen.attachments, message.quotedMessage);
        if (entry === undefined) {
          return false;
        }
        sendJson(response, 202, { entry });
      }
      return true;
    }
    if (id !== undefined && action === "/interrupt" && method === "POST") {
      request.resume();
      if (!isJson(request)) {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return true;
      }
      const conversation = conversations.interrupt(id);
      if (conversation === undefined) {
        return false;
      }
      sendJson(response, 202, { conversation });
      return true;
    }
    return false;
  };

  const serveTicketFile = (response: ServerResponse, ticket: number, encoded: string): boolean => {
    let name: string;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      return false;
    }
    const file = options.files?.get(ticket, name);
    if (file === undefined) {
      return false;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": file.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    const body = file.open();
    body.on("error", () => response.destroy());
    response.on("close", () => body.destroy());
    body.pipe(response);
    return true;
  };

  const serveHistory = (response: ServerResponse, url: URL, tickets: TicketService): boolean => {
    const limit = integerParameter(url, "limit", historyPageSize, historyLargestPage);
    const query = url.searchParams.get("q") ?? "";
    const given = url.searchParams.get("before");
    const before = given === null ? undefined : positionOfCursor(given);
    if (limit === undefined || limit < 1 || query.length > historyQueryLength || (given !== null && before === undefined)) {
      return false;
    }
    sendJson(response, 200, tickets.history({ query, limit, ...(before === undefined ? {} : { before }) }));
    return true;
  };

  const serveTickets = (request: IncomingMessage, response: ServerResponse, path: string, method: string): boolean => {
    const tickets = options.tickets;
    if (tickets === undefined || method !== "GET") {
      return false;
    }
    const url = new URL(request.url ?? "/", "http://hub");
    if (path === ticketsPath) {
      const scope = url.searchParams.get("scope") ?? "open";
      if (scope === "ended") {
        return serveHistory(response, url, tickets);
      }
      const limit = integerParameter(url, "limit", maximumListLimit, maximumListLimit);
      if (limit === undefined || (scope !== "open" && scope !== "all")) {
        return false;
      }
      sendJson(response, 200, { tickets: tickets.list({ open: scope === "open", limit }) });
      return true;
    }
    const fileRoute = ticketFileRoute.exec(path);
    if (fileRoute?.[1] !== undefined && fileRoute[2] !== undefined) {
      return serveTicketFile(response, Number(fileRoute[1]), fileRoute[2]);
    }
    const id = ticketRoute.exec(path)?.[1];
    const detail = id === undefined ? undefined : tickets.detail(Number(id));
    if (detail === undefined) {
      return false;
    }
    sendJson(response, 200, detail);
    return true;
  };

  const serveDecisionReview = async (request: IncomingMessage, response: ServerResponse, path: string, method: string): Promise<boolean> => {
    const reviews = options.reviews;
    const route = ticketDecisionRoute.exec(path);
    if (reviews === undefined || route?.[1] === undefined || route[2] === undefined || method !== "POST") {
      return false;
    }
    if (!ownerAction(request, response)) {
      return true;
    }
    const given = parseJson(await readBody(request), DecisionReview);
    if (given === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return true;
    }
    const outcome = reviews.review(Number(route[1]), Number(route[2]), given);
    if (!outcome.ok) {
      sendJson(response, outcome.error === "not_found" ? 404 : 409, { error: outcome.error });
      return true;
    }
    sendJson(response, 202, { ticket: outcome.ticket });
    return true;
  };

  const serveTicketWork = async (request: IncomingMessage, response: ServerResponse, path: string, method: string): Promise<boolean> => {
    const tickets = options.tickets;
    const work = options.work;
    const route = ticketWorkRoute.exec(path);
    if (tickets === undefined || route?.[1] === undefined) {
      return false;
    }
    const id = Number(route[1]);
    if (tickets.get(id) === undefined) {
      return false;
    }
    if (route[2] === "work") {
      if (method !== "GET" || work === undefined) {
        return false;
      }
      const url = new URL(request.url ?? "/", "http://hub");
      const after = integerParameter(url, "after", 0, Number.MAX_SAFE_INTEGER);
      const limit = integerParameter(url, "limit", maximumWorkEvents, maximumWorkEvents);
      if (after === undefined || limit === undefined) {
        return false;
      }
      sendJson(response, 200, { events: work.events(id, after, limit) });
      return true;
    }
    if (method !== "POST") {
      return false;
    }
    if (!ownerAction(request, response)) {
      return true;
    }
    if (route[2] === "answer") {
      const loop = options.loop;
      if (loop === undefined) {
        request.resume();
        sendJson(response, 404, { error: "not_found" });
        return true;
      }
      const given = parseJson(await readBody(request), StuckAnswerRequest.strict());
      if (given === undefined) {
        sendJson(response, 400, { error: "bad_request" });
        return true;
      }
      const outcome = await loop.answer({ assertion: headerValue(request), ticket: id, request: given });
      if (!outcome.ok) {
        sendJson(response, stuckAnswerStatus[outcome.error], { error: outcome.error });
        return true;
      }
      options.waiting?.refresh();
      sendJson(response, 202, { ticket: outcome.ticket });
      return true;
    }
    if (route[2] === "stop") {
      await readBody(request);
      const result = tickets.stop(id, ownerStopReason);
      if (!result.ok) {
        sendJson(response, result.error === "not_found" ? 404 : 409, { error: result.error === "not_found" ? "not_found" : "conflict" });
        return true;
      }
      options.loop?.ownerStopped(result.ticket);
      sendJson(response, 202, { ticket: result.ticket });
      return true;
    }
    if (work === undefined) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return true;
    }
    const given = parseJson(await readBody(request), WorkerMessage);
    if (given === undefined) {
      sendJson(response, 400, { error: "bad_request" });
      return true;
    }
    const chosen = chooseAttachments(given.attachments);
    if (!chosen.ok) {
      sendJson(response, 409, { error: "conflict" });
      return true;
    }
    const sent = work.message(id, given.text, "owner", chosen.attachments);
    if (!sent.ok) {
      sendJson(response, 409, { error: "conflict" });
      return true;
    }
    sendJson(response, 202, { id: sent.id });
    return true;
  };

  const serveBrain = (client: WebSocket): void => {
    const conversations = options.conversations;
    if (conversations === undefined) {
      client.close(1011, "unavailable");
      return;
    }
    const link = conversations.attach({
      send: (message) => {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify(message));
        }
      },
      close: () => client.close(4000, "replaced"),
    });
    client.on("close", () => link.detach());
    client.on("message", (data, binary) => {
      let message: BrainMessage;
      try {
        message = BrainMessage.parse(binary ? undefined : JSON.parse(String(data)));
      } catch {
        client.close(1008, "invalid message");
        return;
      }
      link.receive(message);
    });
  };

  const heartbeat = options.heartbeatMilliseconds ?? 15000;

  const serveRunner = (client: WebSocket, machine: Machine): void => {
    const runners = options.runners;
    if (runners === undefined) {
      client.close(1011, "unavailable");
      return;
    }
    const link = runners.attach(machine, {
      send: (message) => {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify(message));
        }
      },
      close: (code, reason) => {
        if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
          client.close(code, reason);
        }
      },
    });
    let alive = true;
    client.on("pong", () => {
      alive = true;
    });
    const timer = setInterval(() => {
      if (!alive) {
        client.terminate();
        return;
      }
      alive = false;
      client.ping();
    }, heartbeat);
    timer.unref();
    client.on("close", () => {
      clearInterval(timer);
      link.closed();
    });
    client.on("message", (data, binary) => {
      alive = true;
      let message: RunnerToHub;
      try {
        message = RunnerToHub.parse(binary ? undefined : JSON.parse(String(data)));
      } catch {
        client.close(1008, "invalid message");
        return;
      }
      link.receive(message);
    });
  };

  const serveSocket = (client: WebSocket, identity: Identity): void => {
    const followed = new Set<string>();
    const watched = new Set<string>();
    const watchedTickets = new Set<number>();
    let watchingStream: { scope?: TopicScope | undefined; subscription?: number | undefined } | undefined;
    const streamTag = () => ({ subscription: watchingStream?.subscription });
    const send = (message: ServerMessage) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify(message));
      }
    };
    const unsubscribe = options.commands.subscribe((event) => {
      if (event.type === "command" || followed.has(event.chunk.command)) {
        send(event);
      }
    });
    const unsubscribeConversations =
      options.conversations?.subscribe((event) => {
        if (event.type === "entry") {
          if (watched.has(event.topic.id)) {
            send({ type: "entry", entry: event.entry });
          }
          if (watchingStream !== undefined && (watchingStream.scope === undefined || topicInScope(event.topic, watchingStream.scope))) {
            send({ ...event, type: "stream.entry", ...streamTag() });
          }
        } else if (event.type !== "delta" || watched.has(event.conversation)) {
          send(event);
        } else if (watchingStream !== undefined) {
          const topic = watchingStream.scope === undefined ? undefined : options.conversations?.get(event.conversation);
          if (watchingStream.scope === undefined || (topic !== undefined && topicInScope(topic, watchingStream.scope))) {
            send(event);
          }
        }
      }) ?? (() => undefined);
    const unsubscribeWaiting =
      options.waiting?.subscribe((cards) => send({ type: "waiting", cards: [...cards] })) ?? (() => undefined);
    const unsubscribeTickets = options.tickets?.subscribe((ticket) => send({ type: "ticket", ticket })) ?? (() => undefined);
    const unsubscribeMemories = options.memories?.subscribe((list) => send({ type: "memories", ...list })) ?? (() => undefined);
    const unsubscribeAllowance = options.defaults?.subscribe(() => send({ type: "allowance", allowance: allowanceSnapshot(options.defaults!) })) ?? (() => undefined);
    const unsubscribeSettings = options.settings?.subscribe((settings) => send({ type: "settings", settings })) ?? (() => undefined);
    const unsubscribeWork =
      options.work?.subscribe((event) => {
        if (watchedTickets.has(event.ticket)) {
          send({ type: "work", event });
        }
      }) ?? (() => undefined);
    client.on("close", () => {
      unsubscribeWork();
      unsubscribe();
      unsubscribeConversations();
      unsubscribeWaiting();
      unsubscribeTickets();
      unsubscribeMemories();
      unsubscribeSettings();
      unsubscribeAllowance();
    });
    client.on("message", (data, binary) => {
      let message: ClientMessage;
      try {
        message = ClientMessage.parse(binary ? undefined : JSON.parse(String(data)));
      } catch {
        client.close(1008, "invalid message");
        return;
      }
      if (message.type === "unfollow") {
        followed.delete(message.command);
        return;
      }
      if (message.type === "unwatch") {
        watched.delete(message.conversation);
        return;
      }
      if (message.type === "watch.stream") {
        const conversations = options.conversations;
        if (conversations !== undefined) {
          watchingStream = { scope: message.scope, subscription: message.subscription };
          if (message.after === undefined) {
            send({ type: "stream.page", ...conversations.stream(undefined, undefined, message.scope), ...streamTag() });
          } else if (message.scope !== undefined) {
            send({ type: "stream.page", ...conversations.streamAfter(message.after, message.scope), resumed: true, ...streamTag() });
          } else {
            const { entries, turns } = conversations.streamAfter(message.after);
            for (const turn of turns) {
              send({ type: "turn", turn });
            }
            for (const item of entries) {
              send({ type: "stream.entry", ...item, ...streamTag() });
            }
          }
        }
        return;
      }
      if (message.type === "unwatch.stream") {
        watchingStream = undefined;
        return;
      }
      if (message.type === "read.stream") {
        if (watchingStream !== undefined && options.conversations !== undefined) {
          send({ type: "stream.page", ...options.conversations.stream(message.before, undefined, watchingStream.scope), ...streamTag() });
        }
        return;
      }
      if (message.type === "watch.ticket") {
        watchedTickets.add(message.ticket);
        for (const event of options.work?.events(message.ticket, message.after) ?? []) {
          send({ type: "work", event });
        }
        return;
      }
      if (message.type === "unwatch.ticket") {
        watchedTickets.delete(message.ticket);
        return;
      }
      if (message.type === "watch") {
        watched.add(message.conversation);
        for (const entry of options.conversations?.entries(message.conversation, message.after) ?? []) {
          send({ type: "entry", entry });
        }
        return;
      }
      followed.add(message.command);
      for (const chunk of options.commands.output(message.command, message.after)) {
        send({ type: "output", chunk });
      }
    });
    send({ type: "hello", protocol: protocolVersion, identity });
    if (options.defaults !== undefined) send({ type: "allowance", allowance: allowanceSnapshot(options.defaults) });
    if (options.waiting !== undefined) {
      send({ type: "waiting", cards: options.waiting.cards() });
    }
    if (options.tickets !== undefined) {
      send({ type: "tickets", tickets: options.tickets.list({ open: true, limit: maximumListLimit }), reviews: options.tickets.reviews() });
    }
    if (options.memories !== undefined) {
      send({ type: "memories", ...options.memories.snapshot() });
    }
    if (options.settings !== undefined) {
      send({ type: "settings", settings: options.settings.snapshot() });
    }
  };

  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const path = pathOf(request);
    if (isBrainPath(path)) {
      if (!isBrain(request)) {
        refuseSocket(socket, 403);
        return;
      }
      if (path !== brainLinkPath) {
        refuseSocket(socket, 404);
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client: WebSocket) => serveBrain(client));
      return;
    }
    if (isRunnerPath(path)) {
      const machine = await runnerMachine(request);
      if (machine === undefined) {
        refuseSocket(socket, 403);
        return;
      }
      if (path !== runnerLinkPath) {
        refuseSocket(socket, 404);
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client: WebSocket) => serveRunner(client, machine));
      return;
    }
    const identity = await authenticate(request);
    if (identity === undefined) {
      refuseSocket(socket, 403);
      return;
    }
    if (pathOf(request) !== socketPath) {
      refuseSocket(socket, 404);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client: WebSocket) => serveSocket(client, identity));
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 403, { error: "forbidden" });
      } else {
        response.destroy();
      }
    });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    upgrade(request, socket, head).catch(() => socket.destroy());
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(port, host, () => {
          server.off("error", failed);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of sockets.clients) {
          client.terminate();
        }
        sockets.close();
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
