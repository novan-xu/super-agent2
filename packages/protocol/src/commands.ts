import { z } from "zod";

export const gitHubAccounts = ["novan-xu", "nuofan-island"] as const;

export const GitHubAccount = z.enum(gitHubAccounts);

export type GitHubAccount = z.infer<typeof GitHubAccount>;

export const defaultGitHubAccount: GitHubAccount = "novan-xu";

export const TargetName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export type TargetName = z.infer<typeof TargetName>;

export const VariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100);

export const CommandEnvironment = z.record(VariableName, z.string().max(10_000));

export type CommandEnvironment = z.infer<typeof CommandEnvironment>;

export const CommandRequest = z.object({
  target: TargetName,
  command: z.string().min(1),
  account: GitHubAccount.default(defaultGitHubAccount),
  cwd: z.string().min(1).optional(),
  environment: CommandEnvironment.optional(),
});

export type CommandRequest = z.input<typeof CommandRequest>;

export const CommandState = z.enum(["pending", "held", "running", "exited", "stopped", "dropped", "failed", "interrupted"]);

export type CommandState = z.infer<typeof CommandState>;

export const finishedStates: readonly CommandState[] = ["exited", "stopped", "dropped", "failed", "interrupted"];

export const CommandRecord = z.object({
  id: z.string().min(1),
  target: TargetName,
  command: z.string(),
  account: GitHubAccount,
  cwd: z.string().nullable(),
  state: CommandState,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
});

export type CommandRecord = z.infer<typeof CommandRecord>;

export const OutputStream = z.enum(["stdout", "stderr"]);

export type OutputStream = z.infer<typeof OutputStream>;

export const OutputChunk = z.object({
  command: z.string().min(1),
  seq: z.number().int().positive(),
  stream: OutputStream,
  data: z.string(),
  at: z.number().int(),
});

export type OutputChunk = z.infer<typeof OutputChunk>;

export const CommandList = z.object({
  commands: z.array(CommandRecord),
});

export type CommandList = z.infer<typeof CommandList>;

export const CommandResponse = z.object({
  command: CommandRecord,
});

export type CommandResponse = z.infer<typeof CommandResponse>;

export const OutputResponse = z.object({
  chunks: z.array(OutputChunk),
});

export type OutputResponse = z.infer<typeof OutputResponse>;

export const CommandUpdate = z.object({
  type: z.literal("command"),
  command: CommandRecord,
});

export type CommandUpdate = z.infer<typeof CommandUpdate>;

export const CommandOutput = z.object({
  type: z.literal("output"),
  chunk: OutputChunk,
});

export type CommandOutput = z.infer<typeof CommandOutput>;

export const FollowCommand = z.object({
  type: z.literal("follow"),
  command: z.string().min(1),
  after: z.number().int().nonnegative().default(0),
});

export type FollowCommand = z.input<typeof FollowCommand>;

export const UnfollowCommand = z.object({
  type: z.literal("unfollow"),
  command: z.string().min(1),
});

export type UnfollowCommand = z.infer<typeof UnfollowCommand>;
