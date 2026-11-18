import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

export const name = "super-agent2-dsh-control";
export const inject = ["agents"];

export type ControlBlock = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly attachment: unknown };

export interface ControlMessage {
  readonly role: "user";
  readonly content: readonly ControlBlock[];
  readonly source: { readonly kind: "user" };
  readonly id: string;
}

export interface ControlAgent {
  readonly status: string;
  steer(message: ControlMessage): void;
  cancel(cause: { readonly kind: "user" }): void;
}

export interface ControlSessionEvent {
  readonly type: string;
}

export interface ControlImageStore {
  saveImages(images: readonly { readonly data: Uint8Array; readonly mediaType: string }[]): Promise<readonly unknown[]>;
}

export interface ControlContext {
  readonly agents: { get(id: string): ControlAgent | undefined };
  get?(service: string): unknown;
  on(event: "session/event", listener: (session: { readonly id: unknown }, event: ControlSessionEvent) => void): () => void;
  effect(execute: () => () => void, label?: string): unknown;
}

export interface ControlConfig {
  readonly path?: string;
}

export type ControlResult = "steered" | "cancelled" | "idle";

export interface Controller {
  command(method: string, params: unknown): Promise<ControlResult>;
  observe(session: string, type: string): void;
}

export interface ControlImage {
  readonly path: string;
  readonly mediaType: string;
}

function field(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(params, key);
  return typeof value === "string" ? value : undefined;
}

function imagesOf(params: unknown): ControlImage[] {
  const value: unknown = typeof params === "object" && params !== null ? Reflect.get(params, "images") : undefined;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown) => {
    const path = field(item, "path");
    const mediaType = field(item, "mediaType");
    return path === undefined || mediaType === undefined ? [] : [{ path, mediaType }];
  });
}

function isImageStore(value: unknown): value is ControlImageStore {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "saveImages") === "function";
}

async function imageBlocks(images: readonly ControlImage[], store: unknown): Promise<ControlBlock[]> {
  if (images.length === 0 || !isImageStore(store)) {
    return [];
  }
  try {
    const loaded = await Promise.all(images.map(async (image) => ({ data: new Uint8Array(await readFile(image.path)), mediaType: image.mediaType })));
    const references = await store.saveImages(loaded);
    return references.map((attachment) => ({ type: "image", attachment }));
  } catch {
    return [];
  }
}

export function createController(agents: ControlContext["agents"], images: () => unknown = () => undefined): Controller {
  const open = new Set<string>();
  const steerable = (session: string): ControlAgent | undefined => {
    const agent = agents.get(session);
    return agent !== undefined && agent.status === "running" && open.has(session) ? agent : undefined;
  };
  return {
    observe: (session, type) => {
      if (type === "turn/start") {
        open.add(session);
      } else if (type === "turn/end") {
        open.delete(session);
      }
    },
    command: async (method, params) => {
      const session = field(params, "sessionId");
      if (session === undefined) {
        throw new Error("sessionId is required");
      }
      switch (method) {
        case "steer": {
          const text = field(params, "text");
          if (text === undefined) {
            throw new Error("text is required");
          }
          if (steerable(session) === undefined) {
            return "idle";
          }
          const attached = await imageBlocks(imagesOf(params), images());
          const agent = steerable(session);
          if (agent === undefined) {
            return "idle";
          }
          const message: ControlMessage = { role: "user", content: [{ type: "text", text }, ...attached], source: { kind: "user" }, id: randomUUID() };
          agent.steer(Object.freeze(message));
          return "steered";
        }
        case "cancel": {
          const agent = agents.get(session);
          if (agent === undefined || agent.status !== "running") {
            return "idle";
          }
          agent.cancel({ kind: "user" });
          return "cancelled";
        }
        default:
          throw new Error(`unknown method: ${method}`);
      }
    },
  };
}

async function answer(socket: Socket, controller: Controller, line: string): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof request !== "object" || request === null) {
    return;
  }
  const id: unknown = Reflect.get(request, "id");
  const method = field(request, "method");
  if (method === undefined || (typeof id !== "number" && typeof id !== "string")) {
    return;
  }
  let reply: Record<string, unknown>;
  try {
    reply = { jsonrpc: "2.0", id, result: await controller.command(method, Reflect.get(request, "params")) };
  } catch (error) {
    reply = { jsonrpc: "2.0", id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } };
  }
  socket.write(`${JSON.stringify(reply)}\n`);
}

export function apply(ctx: ControlContext, config: ControlConfig | undefined): Promise<void> {
  const path = config?.path;
  if (path === undefined || path === "") {
    return Promise.resolve();
  }
  const controller = createController(ctx.agents, () => {
    try {
      return ctx.get?.("attachments");
    } catch {
      return undefined;
    }
  });
  ctx.on("session/event", (session, event) => controller.observe(String(session.id), event.type));
  return new Promise((resolve) => {
    ctx.effect(() => {
      const socket = connect(path, () => resolve());
      socket.setEncoding("utf8");
      socket.on("error", () => resolve());
      const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
      lines.on("line", (line) => void answer(socket, controller, line));
      return () => {
        lines.close();
        socket.destroy();
        resolve();
      };
    }, "super-agent2.control");
  });
}
