import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { HubDatabase } from "./database.js";

export interface Peer {
  readonly name: string;
  readonly clientId: string;
  readonly accessTokenId: string;
}

export interface PeerStore {
  list(): readonly Peer[];
  find(name: string): Peer | undefined;
  admit(clientId: string, token: string | undefined): Peer | undefined;
  add(peer: Peer): string;
  remove(name: string): void;
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function peerOf(row: Record<string, unknown>): Peer {
  return { name: String(row.name), clientId: String(row.client_id), accessTokenId: String(row.access_token_id) };
}

export function createPeerStore(database: HubDatabase): PeerStore {
  const db = database.connection;
  const byName = db.prepare("SELECT * FROM peers WHERE name = ?");
  const byClient = db.prepare("SELECT * FROM peers WHERE client_id = ?");
  const add = db.prepare("INSERT INTO peers (name, client_id, access_token_id, token_hash) VALUES (?, ?, ?, ?)");
  const remove = db.prepare("DELETE FROM peers WHERE name = ?");
  const all = db.prepare("SELECT * FROM peers ORDER BY name");
  return {
    list: () => all.all().map(peerOf),
    find: (name) => {
      const row = byName.get(name);
      return row === undefined ? undefined : peerOf(row);
    },
    admit: (clientId, token) => {
      if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      const row = byClient.get(clientId);
      const expected = row?.token_hash;
      return row !== undefined && expected instanceof Uint8Array && timingSafeEqual(expected, hash(token)) ? peerOf(row) : undefined;
    },
    add: (peer) => {
      const token = randomBytes(32).toString("base64url");
      add.run(peer.name, peer.clientId, peer.accessTokenId, hash(token));
      return token;
    },
    remove: (name) => { remove.run(name); },
  };
}
