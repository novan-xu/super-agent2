import { cardParameter, type PageRoute, pageRoute } from "@super-agent2/protocol";

export interface Destination {
  readonly route: PageRoute;
  readonly card: string | null;
}

export function destinationOf(address: string, origin: string): Destination | undefined {
  let url: URL;
  try {
    url = new URL(address, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) {
    return undefined;
  }
  const route = pageRoute(url.pathname, url.search);
  if (route === undefined) {
    return undefined;
  }
  const card = url.searchParams.get(cardParameter);
  return { route, card: card === null || card === "" ? null : card };
}

export function destinationOfMessage(data: unknown, origin: string): Destination | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const message = data as Readonly<Record<string, unknown>>;
  return message["type"] === "open" && typeof message["url"] === "string" ? destinationOf(message["url"], origin) : undefined;
}
