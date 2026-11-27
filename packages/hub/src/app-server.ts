import { createRpc, invocationOf, type LineProcess, type Rpc, RpcError, RpcTimeout, spawnLines } from "@super-agent2/programs";
import { z } from "zod";

type AppFailure = "timeout" | "process unavailable" | "invalid response" | "tool refused" | "tool unavailable" | "tool not allowed"
  | "owner request required" | "write outcome unknown";

export class AppGatewayError extends Error {
  constructor(readonly kind: AppFailure, readonly status?: number) {
    super(`App gateway: ${kind}${status === undefined ? "" : ` (HTTP ${status})`}`);
  }
}

export function appRefusal(detail: string, code?: number): AppGatewayError {
  const status = code !== undefined && code >= 400 && code <= 599
    ? code
    : /\b(?:HTTP(?: status(?: code)?)?[: ]+|status(?: code)?[: ]+)([45]\d\d)\b/i.exec(detail)?.[1]
      ?? (/TickTick API error \[resource_not_found\]/i.test(detail) ? 404 : undefined);
  return new AppGatewayError("tool refused", status === undefined ? undefined : Number(status));
}

const Thread = z.object({ thread: z.object({ id: z.string().min(1) }) });
const threadMissing = /^(?:(?:unknown |could not find )thread(?: with id)?\b|thread not found\b|thread\s+[\w-]+\s+not found\b|no rollout found for thread\b)/i;
const serverArguments = ["app-server", "-c", "features.plugins=false", "-c", "features.apps=true"];

export interface AppServerOptions {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly command?: string;
  readonly startupMilliseconds?: number;
  readonly requestMilliseconds?: number;
}

interface AppSession {
  readonly child: LineProcess;
  readonly rpc: Rpc;
  readonly ready: Promise<void>;
  thread?: Promise<string> | undefined;
}

export class AppServer {
  private session: AppSession | undefined;
  private closed = false;

  constructor(private readonly options: AppServerOptions) {}

  private connect(): AppSession {
    if (this.closed) {
      throw new AppGatewayError("process unavailable");
    }
    if (this.session !== undefined) {
      return this.session;
    }
    const { cwd, environment, command } = this.options;
    const env = Object.fromEntries(["PATH", "HOME", "CODEX_HOME", "USERPROFILE", "SYSTEMROOT", "TMP", "TEMP", "TMPDIR"].map((name) => [name, environment[name]]));
    let rpc: Rpc | undefined;
    const child = spawnLines(invocationOf(command ?? "codex", serverArguments), {
      cwd,
      env: { ...env, RUST_LOG: "off" },
      onMessage: (message) => rpc?.handle(message),
      tree: true,
    });
    const client = createRpc({
      write: (message) => child.write(message),
      jsonrpc: false,
      onNotification: () => undefined,
      onRequest: () => { throw new Error("App gateway declines server requests"); },
    });
    rpc = client;
    const ready = client.request("initialize", {
      clientInfo: { name: "super-agent2-app-gateway", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    }, this.options.startupMilliseconds ?? 30_000).then(() => {
      client.notify("initialized");
    }).catch(async (error: unknown) => {
      await this.stop(child);
      throw error;
    });
    const session: AppSession = { child, rpc: client, ready };
    this.session = session;
    void child.exited.then(() => {
      if (this.session === session) {
        this.session = undefined;
      }
      client.failAll("App server exited");
    });
    return session;
  }

  private thread(session: AppSession): Promise<string> {
    session.thread ??= session.ready.then(async () => {
      const result = Thread.safeParse(await session.rpc.request("thread/start", {
        ephemeral: true,
        cwd: this.options.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: { "features.plugins": false, "features.apps": true },
      }, this.options.startupMilliseconds ?? 30_000));
      if (!result.success) {
        throw new AppGatewayError("invalid response");
      }
      return result.data.thread.id;
    }).catch(async (error: unknown) => {
      if (error instanceof RpcTimeout || error instanceof AppGatewayError) {
        await this.stop(session.child);
      }
      session.thread = undefined;
      throw error;
    });
    return session.thread;
  }

  async request(method: "mcpServerStatus/list" | "mcpServer/tool/call", args: Record<string, unknown>, beforeWrite?: () => boolean): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const session = this.connect();
      const thread = this.thread(session);
      let threadId: string | undefined;
      try {
        threadId = await thread;
        if (beforeWrite !== undefined && !beforeWrite()) {
          throw new AppGatewayError("owner request required");
        }
        return await session.rpc.request(method, { ...args, threadId }, this.options.requestMilliseconds ?? 60_000);
      } catch (error) {
        if (error instanceof RpcTimeout) {
          throw new AppGatewayError(beforeWrite !== undefined && threadId !== undefined ? "write outcome unknown" : "timeout");
        }
        if (error instanceof AppGatewayError) {
          throw error;
        }
        const missing = threadId !== undefined && error instanceof RpcError && threadMissing.test(error.message);
        if (missing && session.thread === thread) {
          session.thread = undefined;
        }
        if (beforeWrite !== undefined && threadId !== undefined && !session.child.alive()) {
          throw new AppGatewayError("write outcome unknown");
        }
        if (attempt === 0 && (missing || (!session.child.alive() && !this.closed))) {
          continue;
        }
        if (!session.child.alive()) {
          throw new AppGatewayError("process unavailable");
        }
        throw error instanceof RpcError ? appRefusal(error.message, error.code) : new AppGatewayError("invalid response");
      }
    }
  }

  private async stop(child: LineProcess): Promise<void> {
    if (child.alive()) {
      child.kill();
    }
    await child.exited;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.session !== undefined) {
      await this.stop(this.session.child);
    }
  }
}
