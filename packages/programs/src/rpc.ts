import { z } from "zod";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const Incoming = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

export interface RpcOptions {
  readonly write: (message: Readonly<Record<string, unknown>>) => void;
  readonly jsonrpc: boolean;
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onRequest: (method: string, params: unknown) => unknown;
}

export interface Rpc {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  handle(message: unknown): void;
  failAll(reason: string): void;
}

export function createRpc(options: RpcOptions): Rpc {
  const pending = new Map<string | number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  let next = 1;
  const frame = (body: Record<string, unknown>) => (options.jsonrpc ? { jsonrpc: "2.0", ...body } : body);
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next;
        next += 1;
        pending.set(id, { resolve, reject });
        options.write(frame(params === undefined ? { id, method } : { id, method, params }));
      }),
    notify: (method, params) => {
      options.write(frame(params === undefined ? { method } : { method, params }));
    },
    handle: (raw) => {
      const parsed = Incoming.safeParse(raw);
      if (!parsed.success) {
        return;
      }
      const message = parsed.data;
      if (message.method !== undefined && message.id !== undefined) {
        const id = message.id;
        Promise.resolve()
          .then(() => options.onRequest(message.method ?? "", message.params))
          .then(
            (result) => options.write(frame({ id, result: result ?? {} })),
            (error: unknown) =>
              options.write(frame({ id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } })),
          );
        return;
      }
      if (message.method !== undefined) {
        options.onNotification(message.method, message.params);
        return;
      }
      if (message.id === undefined) {
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) {
        return;
      }
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new RpcError(message.error.code ?? -32603, message.error.message ?? "Unknown error"));
      } else {
        waiter.resolve(message.result);
      }
    },
    failAll: (reason) => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error(reason));
      }
      pending.clear();
    },
  };
}
