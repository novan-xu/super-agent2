import type { Provider } from "@super-agent2/protocol";

export type ProgramEvent =
  | { readonly type: "session"; readonly session: string }
  | { readonly type: "model"; readonly model: string; readonly effort: string | null }
  | { readonly type: "text"; readonly block: string; readonly delta: string }
  | { readonly type: "tool.started"; readonly call: string; readonly name: string; readonly input: string }
  | { readonly type: "tool.output"; readonly call: string; readonly delta: string }
  | { readonly type: "tool.finished"; readonly call: string; readonly output: string | null; readonly ok: boolean }
  | { readonly type: "turn.finished"; readonly outcome: "completed" | "interrupted" }
  | { readonly type: "unavailable"; readonly reason: string; readonly until: number | null }
  | { readonly type: "failed"; readonly reason: string; readonly lostSession: boolean };

export type ProgramListener = (event: ProgramEvent) => void;

export interface ToolEndpoint {
  readonly url: string;
  readonly token: string;
  readonly conversation: string;
  readonly turn: string;
}

export interface OpenOptions {
  readonly session: string | null;
  readonly tools: ToolEndpoint | null;
  readonly workspace: string;
  readonly textOnly?: boolean;
}

export type SteerResult = "steered" | "queued";

export interface PromptImage {
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface ProgramHandle {
  start(prompt: string, images?: readonly PromptImage[]): void;
  steer(text: string, images?: readonly PromptImage[]): Promise<SteerResult>;
  interrupt(): void;
  close(): Promise<void>;
  processId?(): number | undefined;
}

export type WorkerProgramName = Provider | "antigravity";

export interface ProgramAdapter<Name extends WorkerProgramName = Provider> {
  readonly provider: Name;
  readonly model: string;
  readonly effort: string;
  open(options: OpenOptions, listener: ProgramListener): ProgramHandle;
}

export type WorkerAdapter = ProgramAdapter<WorkerProgramName>;
