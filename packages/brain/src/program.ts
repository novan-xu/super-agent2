import type { Provider } from "@super-agent2/protocol";

export type ProgramEvent =
  | { readonly type: "session"; readonly session: string }
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
}

export interface OpenOptions {
  readonly session: string | null;
  readonly tools: ToolEndpoint;
  readonly workspace: string;
}

export type SteerResult = "steered" | "queued";

export interface ProgramHandle {
  start(prompt: string): void;
  steer(text: string): Promise<SteerResult>;
  interrupt(): void;
  close(): Promise<void>;
}

export interface ProgramAdapter {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: string;
  open(options: OpenOptions, listener: ProgramListener): ProgramHandle;
}
