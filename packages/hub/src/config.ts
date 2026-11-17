import { z } from "zod";

function present(message: string) {
  return { error: (issue: { readonly input?: unknown }) => (issue.input === undefined ? "is required" : message) };
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
});

export interface Config {
  readonly accessTeam: string;
  readonly accessAudience: string;
  readonly ownerEmail: string;
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
}

export type ConfigResult = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly problems: readonly string[] };

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const parsed = Environment.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    return { ok: false, problems };
  }
  const value = parsed.data;
  return {
    ok: true,
    config: {
      accessTeam: value.ACCESS_TEAM,
      accessAudience: value.ACCESS_AUD,
      ownerEmail: value.OWNER_EMAIL.toLowerCase(),
      dataDir: value.HUB_DATA_DIR,
      port: value.HUB_PORT,
      host: value.HUB_HOST,
    },
  };
}
