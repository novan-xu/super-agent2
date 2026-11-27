import { cardAddress as protocolCard, pagePath as protocolPath, remotePeerPrefix, remotePeerRoute, ticketAddress as protocolTicket, type PageRoute } from "@super-agent2/protocol";

export function remoteName(): string | undefined {
  return typeof window === "undefined" ? undefined : remotePeerRoute(window.location.pathname)?.name;
}

export function appPath(path: string): string {
  const name = remoteName();
  return name === undefined ? path : remotePeerPrefix(name) + path;
}

export function pagePath(route: PageRoute): string {
  return appPath(protocolPath(route));
}

export function ticketAddress(ticket: number): string {
  return appPath(protocolTicket(ticket));
}

export function cardAddress(key: string): string {
  return appPath(protocolCard(key));
}
