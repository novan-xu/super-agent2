import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";
import { brainTokenFileName } from "./brain-token.js";
import { isAbsolutePath } from "./paths.js";
import { vapidProblem } from "./push.js";
import { validTicketTimeZone } from "./ticket-codes.js";
import { loopbackHost, localOwnerEmail } from "./loopback.js";
import { peerHubUrl, type PeerConnectionConfig } from "./peer-link.js";

function list(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function present(message: string) {
  return { error: (issue: { readonly input?: unknown }) => (issue.input === undefined ? "is required" : message) };
}

function unlessEmpty<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

function positiveMinutes() {
  return unlessEmpty(z.string().regex(/^\d+$/, { error: "must be a whole number of minutes" })
    .transform(Number).pipe(z.number().int().min(1, { error: "must be at least 1" })));
}

const accessTeam = z.string(present("must be text")).regex(
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  present("must be the team name alone, as in <team>.cloudflareaccess.com, in lower case"),
);
const accessAudience = z.string(present("must be text"))
  .regex(/^[0-9a-f]{64}$/, present("must be the application's audience tag, 64 lower-case hexadecimal characters"));
const ownerEmail = z.email(present("must be an email address"));

const Environment = z.object({
  ACCESS_TEAM: unlessEmpty(accessTeam),
  ACCESS_AUD: unlessEmpty(accessAudience),
  ACCESS_RUNNER_AUD: unlessEmpty(z.string().regex(/^[0-9a-f]{64}$/, { error: "must be the runner application's audience tag, 64 lower-case hexadecimal characters" })),
  ACCESS_INBOX_AUD: unlessEmpty(z.string().regex(/^[0-9a-f]{64}$/, { error: "must be the inbox application's audience tag, 64 lower-case hexadecimal characters" })),
  ACCESS_MCP_AUD: unlessEmpty(z.string().regex(/^[0-9a-f]{64}$/, { error: "must be the OAuth MCP application's audience tag, 64 lower-case hexadecimal characters" })),
  ACCESS_PEER_AUD: unlessEmpty(accessAudience),
  PEER_HUB_URL: unlessEmpty(z.string().refine((url) => peerHubUrl(url) !== undefined, { error: "must be the NAS HTTPS origin" })),
  PEER_ACCESS_CLIENT_ID: unlessEmpty(z.string().regex(/^[\x21-\x7e]+$/)),
  PEER_ACCESS_CLIENT_SECRET: unlessEmpty(z.string().regex(/^[\x21-\x7e]+$/)),
  PEER_TOKEN: unlessEmpty(z.string().regex(/^[A-Za-z0-9_-]{43}$/)),
  OWNER_EMAIL: unlessEmpty(ownerEmail),
  HUB_DATA_DIR: z.string(present("must be text")).min(1, { error: "must not be empty" }),
  HUB_PORT: z
    .string()
    .regex(/^\d+$/, { error: "must be a port number" })
    .transform(Number)
    .pipe(z.number().int().max(65535, { error: "must be between 0 and 65535" }))
    .default(8080),
  HUB_HOST: z.string().min(1, { error: "must not be empty" }).optional(),
  HUB_WORK_REQUEST_PORT: unlessEmpty(z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().max(65535))),
  HUB_WORK_SOURCES_DIR: unlessEmpty(z.string().refine(isAbsolutePath, { error: "must be an absolute folder" })),
  HUB_TICKET_TIME_ZONE: unlessEmpty(z.string().refine(validTicketTimeZone, { error: "must be a valid time zone, such as America/New_York" })),
  HUB_PROJECT_FOLDERS: z
    .string()
    .optional()
    .transform(list)
    .refine((folders) => folders.every(isAbsolutePath), {
      error: "must be absolute folders separated by commas, such as /srv/projects,~/work",
    }),
  HUB_BRAIN_TOKEN_FILE: z.string().min(1, { error: "must not be empty" }).optional(),
  HUB_CONVERTER_URL: unlessEmpty(z.url()),
  HUB_APP_GATEWAY: unlessEmpty(z.enum(["0", "1"])),
  HUB_DEVICE_TRANSFER: unlessEmpty(z.enum(["0", "1"])),
  HUB_MAIL_INTAKE: unlessEmpty(z.enum(["0", "1"])),
  HUB_PAGE_DIR: z.string().min(1, { error: "must not be empty" }).optional(),
  HUB_ATTACHMENTS_DIR: z.string().min(1, { error: "must not be empty" }).optional(),
  SUPERAGENT2_REVISION: unlessEmpty(z.string().regex(/^[0-9a-f]{40}$/, { error: "must be a full commit id, 40 lower-case hexadecimal characters" })),
  HUB_SOURCE_REPOSITORY: unlessEmpty(RepositoryName),
  HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES: positiveMinutes(),
  HUB_WORKER_SILENCE_MINUTES: positiveMinutes(),
  HUB_TOPIC_TIDY_TIME: unlessEmpty(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { error: "must be HH:MM" })),
  HUB_TOPIC_TIDY_ENABLED: unlessEmpty(z.enum(["true", "false"])),
  HUB_TOPIC_ARCHIVE_MS: unlessEmpty(z.string().regex(/^[1-9]\d*$/, { error: "must be a positive number of milliseconds" }).transform(Number).pipe(z.number().int().positive())),
  HUB_ROUTING_MODELS: unlessEmpty(z.string().refine(isAbsolutePath, { error: "must be an absolute folder" })),
  HUB_ROUTING_PRIMARY: unlessEmpty(z.enum(["model", "bigram"], { error: "must be model or bigram" })),
  HUB_DEEPSEEK_LOW_BALANCE: unlessEmpty(z.string().regex(/^\d+(?:\.\d+)?$/, { error: "must be a nonnegative number" }).transform(Number).pipe(z.number().finite())),
  VAPID_PUBLIC_KEY: unlessEmpty(z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, { error: "must be URL-safe base64" })),
  VAPID_PRIVATE_KEY: unlessEmpty(z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, { error: "must be URL-safe base64" })),
  VAPID_SUBJECT: unlessEmpty(z.string().regex(/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/, { error: "must be a mailto: address or an https URL" })),
});

const AccessEnvironment = Environment.extend({ ACCESS_TEAM: accessTeam, ACCESS_AUD: accessAudience, OWNER_EMAIL: ownerEmail });

interface AccessConfig {
  readonly accessTeam: string;
  readonly accessAudience: string;
  readonly accessRunnerAudience?: string;
  readonly accessInboxAudience?: string;
  readonly accessMcpAudience?: string;
  readonly accessPeerAudience?: string;
}

type LoopbackConfig = { readonly [Key in keyof AccessConfig]?: never };

export type Config = (AccessConfig | LoopbackConfig) & {
  readonly ownerEmail: string;
  readonly outboundPeer?: PeerConnectionConfig;
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly workRequests?: { readonly port: number; readonly directory: string };
  readonly ticketTimeZone?: string;
  readonly projectFolders: readonly string[];
  readonly brainTokenFile: string;
  readonly converterUrl?: string;
  readonly appGateway?: boolean;
  readonly deviceTransfer?: boolean;
  readonly mailIntake?: boolean;
  readonly pageDir?: string;
  readonly attachmentsDir?: string;
  readonly vapid?: VapidSettings;
  readonly version?: string;
  readonly sourceRepository?: string;
  readonly firstPipelineAllowanceMinutes?: number;
  readonly workerSilenceMinutes?: number;
  readonly deepseekLowBalance?: number;
  readonly topicArchiveMilliseconds?: number;
  readonly topicTidyTime?: string;
  readonly topicTidyEnabled?: boolean;
  readonly routingModels?: string;
  readonly routingPrimary?: "model" | "bigram";
};

export interface VapidSettings {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject?: string;
}

function vapidSettings(value: { VAPID_PUBLIC_KEY?: string | undefined; VAPID_PRIVATE_KEY?: string | undefined; VAPID_SUBJECT?: string | undefined }): { readonly settings?: VapidSettings; readonly problems: string[] } {
  const publicKey = value.VAPID_PUBLIC_KEY;
  const privateKey = value.VAPID_PRIVATE_KEY;
  if (publicKey === undefined && privateKey === undefined) {
    return value.VAPID_SUBJECT === undefined ? { problems: [] } : { problems: ["VAPID_SUBJECT is set without VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY"] };
  }
  if (publicKey === undefined || privateKey === undefined) {
    return { problems: [publicKey === undefined ? "VAPID_PUBLIC_KEY is required when VAPID_PRIVATE_KEY is set" : "VAPID_PRIVATE_KEY is required when VAPID_PUBLIC_KEY is set"] };
  }
  const keys = { publicKey: Buffer.from(publicKey, "base64url").toString("base64url"), privateKey: Buffer.from(privateKey, "base64url").toString("base64url") };
  const problem = vapidProblem(keys);
  if (problem !== undefined) {
    return { problems: [problem] };
  }
  return { settings: { ...keys, ...(value.VAPID_SUBJECT === undefined ? {} : { subject: value.VAPID_SUBJECT }) }, problems: [] };
}

export const defaultPageDir = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export type ConfigResult = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly problems: readonly string[] };

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const access = [env.ACCESS_AUD, env.ACCESS_RUNNER_AUD, env.ACCESS_INBOX_AUD, env.ACCESS_MCP_AUD, env.ACCESS_PEER_AUD].some((value) => value !== undefined && value !== "");
  const schema = access ? AccessEnvironment : Environment;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    return { ok: false, problems };
  }
  const value = parsed.data;
  const accessConfig: AccessConfig | LoopbackConfig = access ? {
    accessTeam: value.ACCESS_TEAM!,
    accessAudience: value.ACCESS_AUD!,
    ...(value.ACCESS_RUNNER_AUD === undefined ? {} : { accessRunnerAudience: value.ACCESS_RUNNER_AUD }),
    ...(value.ACCESS_INBOX_AUD === undefined ? {} : { accessInboxAudience: value.ACCESS_INBOX_AUD }),
    ...(value.ACCESS_MCP_AUD === undefined ? {} : { accessMcpAudience: value.ACCESS_MCP_AUD }),
    ...(value.ACCESS_PEER_AUD === undefined ? {} : { accessPeerAudience: value.ACCESS_PEER_AUD }),
  } : {};
  const host = value.HUB_HOST ?? (access ? "0.0.0.0" : "127.0.0.1");
  const bind = access ? host : loopbackHost(host);
  if (bind === undefined) {
    return { ok: false, problems: ["HUB_HOST must be a loopback address when Access is not configured"] };
  }
  if (value.ACCESS_RUNNER_AUD !== undefined && value.ACCESS_RUNNER_AUD === value.ACCESS_AUD) {
    return { ok: false, problems: ["ACCESS_RUNNER_AUD must be the audience tag of the separate application for the path runner, not ACCESS_AUD"] };
  }
  if (value.ACCESS_INBOX_AUD !== undefined && (value.ACCESS_INBOX_AUD === value.ACCESS_AUD || value.ACCESS_INBOX_AUD === value.ACCESS_RUNNER_AUD)) {
    return { ok: false, problems: ["ACCESS_INBOX_AUD must be the audience tag of a separate inbox application"] };
  }
  if (value.ACCESS_MCP_AUD !== undefined && [value.ACCESS_AUD, value.ACCESS_RUNNER_AUD, value.ACCESS_INBOX_AUD].includes(value.ACCESS_MCP_AUD)) {
    return { ok: false, problems: ["ACCESS_MCP_AUD must be the audience tag of a separate OAuth MCP application"] };
  }
  if (value.ACCESS_PEER_AUD !== undefined && [value.ACCESS_AUD, value.ACCESS_RUNNER_AUD, value.ACCESS_INBOX_AUD, value.ACCESS_MCP_AUD].includes(value.ACCESS_PEER_AUD)) {
    return { ok: false, problems: ["ACCESS_PEER_AUD must be the audience tag of a separate peer application"] };
  }
  const { PEER_HUB_URL: hub, PEER_ACCESS_CLIENT_ID: clientId, PEER_ACCESS_CLIENT_SECRET: clientSecret, PEER_TOKEN: token } = value;
  let outboundPeer: PeerConnectionConfig | undefined;
  if ([hub, clientId, clientSecret, token].some((setting) => setting !== undefined)) {
    if (hub === undefined || clientId === undefined || clientSecret === undefined || token === undefined) {
      return { ok: false, problems: ["PEER_HUB_URL, PEER_ACCESS_CLIENT_ID, PEER_ACCESS_CLIENT_SECRET and PEER_TOKEN must be set together"] };
    }
    if (access) return { ok: false, problems: ["The outbound peer link requires a loopback hub"] };
    outboundPeer = { hub, clientId, clientSecret, token };
  }
  const { HUB_WORK_REQUEST_PORT: workPort, HUB_WORK_SOURCES_DIR: workDirectory } = value;
  if ((workPort === undefined) !== (workDirectory === undefined)) {
    return { ok: false, problems: ["HUB_WORK_REQUEST_PORT and HUB_WORK_SOURCES_DIR must be set together"] };
  }
  if (workPort !== undefined && workPort !== 0 && workPort === value.HUB_PORT) {
    return { ok: false, problems: ["HUB_WORK_REQUEST_PORT must differ from HUB_PORT"] };
  }
  const vapid = vapidSettings(value);
  if (vapid.problems.length > 0) {
    return { ok: false, problems: vapid.problems };
  }
  return {
    ok: true,
    config: {
      ...accessConfig,
      ...(outboundPeer === undefined ? {} : { outboundPeer }),
      ownerEmail: access ? value.OWNER_EMAIL!.toLowerCase() : localOwnerEmail,
      dataDir: value.HUB_DATA_DIR,
      port: value.HUB_PORT,
      host: bind,
      ...(workPort === undefined || workDirectory === undefined ? {} : { workRequests: { port: workPort, directory: workDirectory } }),
      ...(value.HUB_TICKET_TIME_ZONE === undefined ? {} : { ticketTimeZone: value.HUB_TICKET_TIME_ZONE }),
      projectFolders: value.HUB_PROJECT_FOLDERS,
      brainTokenFile: value.HUB_BRAIN_TOKEN_FILE ?? join(value.HUB_DATA_DIR, brainTokenFileName),
      ...(value.HUB_CONVERTER_URL === undefined ? {} : { converterUrl: value.HUB_CONVERTER_URL.replace(/\/+$/, "") }),
      ...(value.HUB_APP_GATEWAY === undefined ? {} : { appGateway: value.HUB_APP_GATEWAY === "1" }),
      ...(value.HUB_DEVICE_TRANSFER === undefined ? {} : { deviceTransfer: value.HUB_DEVICE_TRANSFER === "1" }),
      ...(value.HUB_MAIL_INTAKE === undefined ? {} : { mailIntake: value.HUB_MAIL_INTAKE === "1" }),
      pageDir: value.HUB_PAGE_DIR ?? defaultPageDir,
      attachmentsDir: value.HUB_ATTACHMENTS_DIR ?? join(value.HUB_DATA_DIR, "attachments"),
      ...(vapid.settings === undefined ? {} : { vapid: vapid.settings }),
      ...(value.SUPERAGENT2_REVISION === undefined ? {} : { version: value.SUPERAGENT2_REVISION }),
      ...(value.HUB_SOURCE_REPOSITORY === undefined ? {} : { sourceRepository: value.HUB_SOURCE_REPOSITORY }),
      ...(value.HUB_TOPIC_TIDY_TIME === undefined ? {} : { topicTidyTime: value.HUB_TOPIC_TIDY_TIME }),
      ...(value.HUB_TOPIC_TIDY_ENABLED === undefined ? {} : { topicTidyEnabled: value.HUB_TOPIC_TIDY_ENABLED === "true" }),
      ...(value.HUB_TOPIC_ARCHIVE_MS === undefined ? {} : { topicArchiveMilliseconds: value.HUB_TOPIC_ARCHIVE_MS }),
      ...(value.HUB_DEEPSEEK_LOW_BALANCE === undefined ? {} : { deepseekLowBalance: value.HUB_DEEPSEEK_LOW_BALANCE }),
      ...(value.HUB_ROUTING_MODELS === undefined ? {} : { routingModels: value.HUB_ROUTING_MODELS }),
      ...(value.HUB_ROUTING_PRIMARY === undefined ? {} : { routingPrimary: value.HUB_ROUTING_PRIMARY }),
      ...(value.HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES === undefined ? {} : { firstPipelineAllowanceMinutes: value.HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES }),
      ...(value.HUB_WORKER_SILENCE_MINUTES === undefined ? {} : { workerSilenceMinutes: value.HUB_WORKER_SILENCE_MINUTES }),
    },
  };
}
