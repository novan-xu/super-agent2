import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

export const name = "super-agent2-dsh-control";
export const inject = ["agents"];

export interface ControlMessage {
  readonly role: "user";
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
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

export interface ControlContext {
  readonly agents: { get(id: string): ControlAgent | undefined };
  on(event: "session/event", listener: (session: { readonly id: unknown }, event: ControlSessionEvent) => void): () => void;
  effect(execute: () => () => void, label?: string): unknown;
}

export interface ControlConfig {
  readonly path?: string;
}

export type ControlResult = "steered" | "cancelled" | "idle";

export interface Controller {
  command(method: string, params: unknown): ControlResult;
  observe(session: string, type: string): void;
}

function field(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(params, key);
  return typeof value === "string" ? value : undefined;
}

export function createController(agents: ControlContext["agents"]): Controller {
  const open = new Set<string>();
  return {
    observe: (session, type) => {
      if (type === "turn/start") {
        open.add(session);
      } else if (type === "turn/end") {
        open.delete(session);
      }
    },
    command: (method, params) => {
      const session = field(params, "sessionId");
      if (session === undefined) {
        throw new Error("sessionId is required");
      }
      const agent = agents.get(session);
      switch (method) {
        case "steer": {
          const text = field(params, "text");
          if (text === undefined) {
            throw new Error("text is required");
          }
          if (agent === undefined || agent.status !== "running" || !open.has(session)) {
            return "idle";
          }
          const message: ControlMessage = { role: "user", content: [{ type: "text", text }], source: { kind: "user" }, id: randomUUID() };
          agent.steer(Object.freeze(message));
          return "steered";
        }
        case "cancel": {
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

function answer(socket: Socket, controller: Controller, line: string): void {
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
    reply = { jsonrpc: "2.0", id, result: controller.command(method, Reflect.get(request, "params")) };
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
  const controller = createController(ctx.agents);
  ctx.on("session/event", (session, event) => controller.observe(String(session.id), event.type));
  return new Promise((resolve) => {
    ctx.effect(() => {
      const socket = connect(path, () => resolve());
      socket.setEncoding("utf8");
      socket.on("error", () => resolve());
      const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
      lines.on("line", (line) => answer(socket, controller, line));
      return () => {
        lines.close();
        socket.destroy();
        resolve();
      };
    }, "super-agent2.control");
  });
}
