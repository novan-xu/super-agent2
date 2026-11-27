import { randomUUID } from "node:crypto";
import type { ClientHttp2Session, ServerHttp2Stream, OutgoingHttpHeaders } from "node:http2";
import type { Readable } from "node:stream";
import { MemoryId, principleLimit, Revision, sharedMemoryLimit } from "@super-agent2/protocol";
import { z } from "zod";
import type { HubDatabase } from "./database.js";

export const peerExchangePath = "/peer/exchange";
export const peerUpdatesHeader = "x-superagent2-peer-updates";
export const sharedUpdateRepository = "novan-xu/super-agent2";
const payloadLimit = 32_768;
const exchangeInterval = 2_000;

const Payload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remember"), item: MemoryId, text: z.string().trim().min(1).max(sharedMemoryLimit) }).strict(),
  z.object({ kind: z.literal("forget"), item: MemoryId }).strict(),
  z.object({ kind: z.literal("principle"), text: z.string().trim().min(1).max(principleLimit) }).strict(),
  z.object({ kind: z.literal("update"), repository: z.literal(sharedUpdateRepository), commit: Revision }).strict(),
]);
export type PeerPayload = z.infer<typeof Payload>;
const Delivery = z.object({ id: z.uuid(), payload: Payload }).strict();
type Delivery = z.infer<typeof Delivery>;
const Exchange = z.object({ acknowledged: z.uuid().optional(), delivery: Delivery.optional() }).strict();
type Exchange = z.infer<typeof Exchange>;

export interface PeerSource {
  readonly id: string;
  readonly name: string;
}

export function nasPeer(hub: string, clientId: string): PeerSource {
  return { id: JSON.stringify([new URL(hub).origin, clientId]), name: "NAS" };
}

export interface PeerQueue {
  readonly available: () => boolean;
  enqueue(payload: PeerPayload): void;
  next(target: string, updates?: boolean): Delivery | undefined;
  acknowledge(target: string, id: string): void;
  receive(source: PeerSource, delivery: Delivery, apply: () => (() => void) | undefined): void;
}

export function createPeerQueue(database: HubDatabase, targets: () => readonly string[]): PeerQueue {
  const db = database.connection;
  const enqueue = db.prepare(`
    INSERT INTO peer_outbox (target, item, id, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT (target, item) DO UPDATE SET id = excluded.id, payload = excluded.payload
  `);
  const next = db.prepare("SELECT id, payload FROM peer_outbox WHERE target = ? AND (? OR item NOT LIKE 'update:%') ORDER BY seq LIMIT 1");
  const ack = db.prepare("DELETE FROM peer_outbox WHERE target = ? AND id = ?");
  const receipt = db.prepare("INSERT OR IGNORE INTO peer_receipts (source, id) VALUES (?, ?)");
  return {
    available: () => targets().length > 0,
    enqueue: (payload) => {
      const item = payload.kind === "principle" ? randomUUID() : payload.kind === "update" ? `update:${payload.commit}` : String(payload.item);
      const encoded = JSON.stringify(Payload.parse(payload));
      for (const target of targets()) enqueue.run(target, item, randomUUID(), encoded);
    },
    next: (target, updates = true) => {
      const row = next.get(target, updates ? 1 : 0);
      return row === undefined ? undefined : Delivery.parse({ id: row.id, payload: JSON.parse(String(row.payload)) });
    },
    acknowledge: (target, id) => { ack.run(target, id); },
    receive: (source, delivery, apply) => {
      let publish: (() => void) | undefined;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (receipt.run(source.id, delivery.id).changes > 0) publish = apply();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      publish?.();
    },
  };
}

export interface PeerExchange {
  readonly queue: PeerQueue;
  receive(source: PeerSource, payload: PeerPayload): (() => void) | undefined;
}

function receive(peer: PeerExchange, source: PeerSource, delivery: Delivery): string {
  peer.queue.receive(source, delivery, () => peer.receive(source, delivery.payload));
  return delivery.id;
}

async function read(stream: Readable): Promise<Exchange> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > payloadLimit) throw new Error("Peer exchange exceeds its size limit");
    chunks.push(chunk);
  }
  return Exchange.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export function serveExchange(stream: ServerHttp2Stream, peer: PeerExchange, source: PeerSource, updates: boolean): void {
  stream.on("error", () => stream.destroy());
  stream.setTimeout(10_000, () => stream.destroy());
  void (async () => {
    const request = await read(stream);
    if (stream.destroyed || stream.closed) return;
    const acknowledged = request.delivery === undefined ? undefined : receive(peer, source, request.delivery);
    if (request.acknowledged !== undefined) peer.queue.acknowledge(source.id, request.acknowledged);
    const delivery = peer.queue.next(source.id, updates);
    stream.respond({ ":status": 200, [peerUpdatesHeader]: "1" });
    stream.end(JSON.stringify({ acknowledged, delivery }));
  })().catch(() => stream.destroy());
}

export function exchangeWithPeer(session: ClientHttp2Session, peer: PeerExchange, source: PeerSource): void {
  let acknowledged: string | undefined;
  let updates = false;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (delay: number) => {
    if (!stopped) timer = setTimeout(poll, delay).unref();
  };
  const poll = async () => {
    if (session.destroyed || session.closed) return;
    try {
      const delivery = peer.queue.next(source.id, updates);
      const headers: OutgoingHttpHeaders = { ":method": "POST", ":path": peerExchangePath, [peerUpdatesHeader]: "1" };
      const stream = session.request(headers);
      stream.setTimeout(10_000, () => stream.destroy());
      const response = new Promise<{ status: number; updates: boolean }>((resolve, reject) => {
        stream.once("response", (headers) => resolve({ status: headers[":status"] ?? 500, updates: headers[peerUpdatesHeader] === "1" }));
        stream.once("error", reject);
        stream.once("close", () => reject(new Error("Peer exchange closed")));
      });
      stream.end(JSON.stringify({ acknowledged, delivery }));
      const replyHeaders = await response;
      const status = replyHeaders.status;
      if (status !== 200) {
        stream.resume();
        if (status !== 404) schedule(exchangeInterval);
        return;
      }
      const reply = await read(stream);
      if (stopped) return;
      if (delivery !== undefined && reply.acknowledged === delivery.id) peer.queue.acknowledge(source.id, delivery.id);
      acknowledged = reply.delivery === undefined ? undefined : receive(peer, source, reply.delivery);
      const learnedUpdates = !updates && replyHeaders.updates;
      updates = replyHeaders.updates;
      schedule(acknowledged === undefined && delivery === undefined && !learnedUpdates ? exchangeInterval : 50);
    } catch {
      schedule(exchangeInterval);
    }
  };
  session.once("close", () => { stopped = true; clearTimeout(timer); });
  schedule(0);
}
