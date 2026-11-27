import { z } from "zod";

export const PeerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export const peerLinkPath = "/peer/link";
export const peerTokenHeader = "x-super-agent2-peer-token";
export const remotePath = "/remote";

export const PeerStatus = z.object({ name: PeerName, online: z.boolean() });
export type PeerStatus = z.infer<typeof PeerStatus>;

export function remotePeerPrefix(name: string): string {
  return `${remotePath}/${name}`;
}

export function remotePeerRoute(path: string): { readonly name: string; readonly path: string } | undefined {
  const match = /^\/remote\/([a-z0-9-]+)(\/.*)?$/.exec(path);
  const name = PeerName.safeParse(match?.[1]);
  return name.success ? { name: name.data, path: match?.[2] ?? "/" } : undefined;
}
