import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";
import { brainTokenFileName } from "./brain-token.js";
import { isAbsolutePath } from "./paths.js";
import { vapidProblem } from "./push.js";
import type { SshDestination } from "./targets.js";

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

const Environment = z.object({
  ACCESS_TEAM: z
    .string(present("must be text"))
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      present("must be the team name alone, as in <team>.cloudflareaccess.com, in lower case"),
    ),
  ACCESS_AUD: z
    .string(present("must be text"))
    .regex(/^[0-9a-f]{64}$/, present("must be the application's audience tag, 64 lower-case hexadecimal characters")),
  OWNER_EMAIL: z.email(present("must be an email address")),
  HUB_DATA_DIR: z.string(present("must be text")).min(1, { error: "must not be empty" }),
  HUB_PORT: z
    .string()
    .regex(/^\d+$/, { error: "must be a port number" })
    .transform(Number)
    .pipe(z.number().int().max(65535, { error: "must be between 0 and 65535" }))
    .default(8080),
  HUB_HOST: z.string().min(1, { error: "must not be empty" }).default("0.0.0.0"),
  NAS_SSH_DESTINATION: z
    .string()
    .regex(/^[^\s-][^\s]*$/, { error: "must be an SSH destination such as user@host, without spaces or a leading dash" })
    .optional(),
  NAS_SSH_PORT: z
    .string()
    .regex(/^\d+$/, { error: "must be a port number" })
    .transform(Number)
    .pipe(z.number().int().min(1, { error: "must be between 1 and 65535" }).max(65535, { error: "must be between 1 and 65535" }))
    .optional(),
  NAS_SSH_IDENTITY: z.string().min(1, { error: "must not be empty" }).optional(),
  HUB_PROJECT_FOLDERS: z
    .string()
    .optional()
    .transform(list)
    .refine((folders) => folders.every(isAbsolutePath), {
      error: "must be absolute folders separated by commas, such as /srv/projects,~/work",
    }),
  HUB_CREDENTIAL_PATHS: z.string().optional().transform(list),
  HUB_BRAIN_TOKEN_FILE: z.string().min(1, { error: "must not be empty" }).optional(),
  HUB_PAGE_DIR: z.string().min(1, { error: "must not be empty" }).optional(),
  HUB_ATTACHMENTS_DIR: z.string().min(1, { error: "must not be empty" }).optional(),
  SUPERAGENT2_REVISION: unlessEmpty(z.string().regex(/^[0-9a-f]{40}$/, { error: "must be a full commit id, 40 lower-case hexadecimal characters" })),
  HUB_SOURCE_REPOSITORY: unlessEmpty(RepositoryName),
  VAPID_PUBLIC_KEY: unlessEmpty(z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, { error: "must be URL-safe base64" })),
  VAPID_PRIVATE_KEY: unlessEmpty(z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, { error: "must be URL-safe base64" })),
  VAPID_SUBJECT: unlessEmpty(z.string().regex(/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/, { error: "must be a mailto: address or an https URL" })),
});

export interface Config {
  readonly accessTeam: string;
  readonly accessAudience: string;
  readonly ownerEmail: string;
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly nas?: SshDestination;
  readonly projectFolders: readonly string[];
  readonly credentialPaths: readonly string[];
  readonly brainTokenFile: string;
  readonly pageDir?: string;
  readonly attachmentsDir?: string;
  readonly vapid?: VapidSettings;
  readonly version?: string;
  readonly sourceRepository?: string;
}

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
  const parsed = Environment.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    return { ok: false, problems };
  }
  const value = parsed.data;
  const vapid = vapidSettings(value);
  if (vapid.problems.length > 0) {
    return { ok: false, problems: vapid.problems };
  }
  return {
    ok: true,
    config: {
      accessTeam: value.ACCESS_TEAM,
      accessAudience: value.ACCESS_AUD,
      ownerEmail: value.OWNER_EMAIL.toLowerCase(),
      dataDir: value.HUB_DATA_DIR,
      port: value.HUB_PORT,
      host: value.HUB_HOST,
      projectFolders: value.HUB_PROJECT_FOLDERS,
      credentialPaths: value.HUB_CREDENTIAL_PATHS,
      brainTokenFile: value.HUB_BRAIN_TOKEN_FILE ?? join(value.HUB_DATA_DIR, brainTokenFileName),
      pageDir: value.HUB_PAGE_DIR ?? defaultPageDir,
      attachmentsDir: value.HUB_ATTACHMENTS_DIR ?? join(value.HUB_DATA_DIR, "attachments"),
      ...(vapid.settings === undefined ? {} : { vapid: vapid.settings }),
      ...(value.SUPERAGENT2_REVISION === undefined ? {} : { version: value.SUPERAGENT2_REVISION }),
      ...(value.HUB_SOURCE_REPOSITORY === undefined ? {} : { sourceRepository: value.HUB_SOURCE_REPOSITORY }),
      ...(value.NAS_SSH_DESTINATION === undefined
        ? {}
        : {
            nas: {
              destination: value.NAS_SSH_DESTINATION,
              ...(value.NAS_SSH_PORT === undefined ? {} : { port: value.NAS_SSH_PORT }),
              ...(value.NAS_SSH_IDENTITY === undefined ? {} : { identityFile: value.NAS_SSH_IDENTITY }),
            },
          }),
    },
  };
}
