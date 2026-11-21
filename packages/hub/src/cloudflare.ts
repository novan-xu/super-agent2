import { z } from "zod";

export interface ServiceToken {
  readonly id: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly expiresAt: number | null;
}

export interface AccessServiceTokens {
  create(name: string): Promise<ServiceToken>;
  remove(id: string): Promise<void>;
}

export interface CloudflareSettings {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
}

export const cloudflareApiBase = "https://api.cloudflare.com/client/v4";

export const serviceTokenDuration = "forever";

export const serviceTokenTag = { key: "superagent2", value: "runner" } as const;

const earliestExpiry = Date.UTC(2000, 0, 1);

const Created = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    duration: z.string().nullish(),
    expires_at: z.string().nullish(),
  }),
});

export function expiryOf(duration: string | null | undefined, expiresAt: string | null | undefined): number | null {
  if (duration === serviceTokenDuration || expiresAt === null || expiresAt === undefined) {
    return null;
  }
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time > earliestExpiry ? time : null;
}

const Failure = z.object({
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).optional(),
});

export function cloudflareSettings(environment: Readonly<Record<string, string | undefined>>): CloudflareSettings | { readonly missing: string[] } {
  const accountId = environment["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  const apiToken = environment["CLOUDFLARE_ACCESS_API_TOKEN"] ?? "";
  const missing = [
    ...(accountId === "" ? ["CLOUDFLARE_ACCOUNT_ID"] : []),
    ...(apiToken === "" ? ["CLOUDFLARE_ACCESS_API_TOKEN"] : []),
  ];
  return missing.length > 0 ? { missing } : { accountId, apiToken };
}

export function cloudflareServiceTokens(settings: CloudflareSettings, tag: "runner" | "inbox" = "runner"): AccessServiceTokens {
  const call = settings.fetch ?? fetch;
  const base = settings.apiBase ?? cloudflareApiBase;
  const failure = async (response: Response, what: string): Promise<Error> => {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const failed = Failure.safeParse(body);
    const messages = failed.success ? (failed.data.errors ?? []).map((error) => error.message) : [];
    return new Error(`Cloudflare refused to ${what} (HTTP ${response.status})${messages.length > 0 ? `: ${messages.join("; ")}` : ""}`);
  };
  return {
    remove: async (id) => {
      const response = await call(`${base}/accounts/${encodeURIComponent(settings.accountId)}/access/service_tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${settings.apiToken}` },
      });
      if (response.ok || response.status === 404) {
        await response.body?.cancel();
        return;
      }
      throw await failure(response, "delete the service token");
    },
    create: async (name) => {
      const response = await call(`${base}/accounts/${encodeURIComponent(settings.accountId)}/access/service_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${settings.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name, duration: serviceTokenDuration, tags: { [serviceTokenTag.key]: tag } }),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const created = Created.safeParse(body);
      if (response.ok && created.success) {
        const result = created.data.result;
        return { id: result.id, clientId: result.client_id, clientSecret: result.client_secret, expiresAt: expiryOf(result.duration, result.expires_at) };
      }
      const failure = Failure.safeParse(body);
      const messages = failure.success ? (failure.data.errors ?? []).map((error) => error.message) : [];
      throw new Error(`Cloudflare refused to create the service token (HTTP ${response.status})${messages.length > 0 ? `: ${messages.join("; ")}` : ""}`);
    },
  };
}
