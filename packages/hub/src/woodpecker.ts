import { RepositoryName } from "@super-agent2/protocol";
import { z } from "zod";
import { type Fetch, ForgeError } from "./github-api.js";

export interface WoodpeckerRepository {
  readonly id: number;
  readonly active: boolean;
  readonly configFile: string;
}

export interface PipelineSummary {
  readonly number: number;
  readonly commit: string;
  readonly ref: string;
  readonly event: string;
  readonly status: string;
  readonly created: number | null;
  readonly finished: number | null;
}

export interface PipelineStep {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly exitCode: number | null;
}

export interface PipelineWorkflow {
  readonly name: string;
  readonly state: string;
  readonly agent: number | null;
  readonly started: number | null;
  readonly finished: number | null;
  readonly steps: readonly PipelineStep[];
}

export interface Pipeline {
  readonly number: number;
  readonly status: string;
  readonly commit: string;
  readonly errors: string | null;
  readonly created: number | null;
  readonly started: number | null;
  readonly finished: number | null;
  readonly workflows: readonly PipelineWorkflow[];
}

export interface WoodpeckerApi {
  repository(repository: string): Promise<WoodpeckerRepository | null>;
  pipelines(repository: number, pullRequest: number, page: number): Promise<PipelineSummary[]>;
  pipeline(repository: number, number: number): Promise<Pipeline>;
  config(repository: number, number: number): Promise<string[]>;
  log(repository: number, number: number, step: number): Promise<string>;
  pipelineUrl(repository: number, number: number): string;
}

export interface WoodpeckerApiOptions {
  readonly fetch: Fetch;
  readonly server: string;
  readonly token: string;
  readonly timeoutMilliseconds?: number;
}

export const pipelinePageSize = 50;

const RepositoryJson = z.looseObject({ id: z.number().int(), active: z.boolean().optional(), config_file: z.string().optional() });

const Seconds = z.number().nullable().optional();

const SummaryJson = z.looseObject({
  number: z.number().int(),
  commit: z.string(),
  ref: z.string().optional(),
  event: z.string().optional(),
  status: z.string().optional(),
  created: Seconds,
  finished: Seconds,
});

const StepJson = z.looseObject({ id: z.number().int(), name: z.string(), state: z.string(), exit_code: z.number().int().nullable().optional() });

const WorkflowJson = z.looseObject({
  name: z.string(),
  state: z.string(),
  agent_id: z.number().int().nullable().optional(),
  started: Seconds,
  finished: Seconds,
  children: z.array(StepJson).nullable().optional(),
});

const PipelineJson = z.looseObject({
  number: z.number().int(),
  status: z.string(),
  commit: z.string(),
  errors: z.unknown().optional(),
  created: Seconds,
  started: Seconds,
  finished: Seconds,
  workflows: z.array(WorkflowJson).nullable().optional(),
});

const ConfigJson = z.array(z.looseObject({ name: z.string() }));

const LogJson = z.array(z.looseObject({ line: z.number().int().optional(), data: z.string().nullable().optional() }));

function milliseconds(seconds: number | null | undefined): number | null {
  return seconds === undefined || seconds === null || seconds <= 0 ? null : Math.round(seconds * 1000);
}

function errorsText(errors: unknown): string | null {
  if (errors === undefined || errors === null) {
    return null;
  }
  if (Array.isArray(errors)) {
    const parts = errors.map((entry) => {
      if (typeof entry === "object" && entry !== null && "message" in entry && typeof entry.message === "string") {
        return entry.message;
      }
      return JSON.stringify(entry);
    });
    return parts.length === 0 ? null : parts.join("; ");
  }
  return JSON.stringify(errors);
}

export function createWoodpeckerApi(options: WoodpeckerApiOptions): WoodpeckerApi {
  const server = options.server.replace(/\/+$/, "");
  const timeout = options.timeoutMilliseconds ?? 60_000;

  const send = async (path: string): Promise<Response> => {
    try {
      return await options.fetch(`${server}${path}`, {
        headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new ForgeError(`Woodpecker could not be reached for ${path}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
  };

  const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await send(path);
    if (!response.ok) {
      throw new ForgeError(`Woodpecker answered ${response.status} to ${path}`, response.status);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ForgeError(`Woodpecker answered ${path} in an unexpected shape: ${parsed.error.message}`, response.status);
    }
    return parsed.data;
  };

  return {
    repository: async (repository) => {
      const path = `/api/repos/lookup/${RepositoryName.parse(repository)}`;
      const response = await send(path);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new ForgeError(`Woodpecker answered ${response.status} to ${path}`, response.status);
      }
      const parsed = RepositoryJson.safeParse(await response.json());
      if (!parsed.success) {
        throw new ForgeError(`Woodpecker answered ${path} in an unexpected shape: ${parsed.error.message}`, response.status);
      }
      return { id: parsed.data.id, active: parsed.data.active === true, configFile: parsed.data.config_file ?? "" };
    },
    pipelines: async (repository, pullRequest, page) => {
      const list = await read(
        `/api/repos/${repository}/pipelines?event=pull_request&ref=${encodeURIComponent(`refs/pull/${pullRequest}/`)}&perPage=${pipelinePageSize}&page=${page}`,
        z.array(SummaryJson).nullable(),
      );
      return (list ?? []).map((entry) => ({
        number: entry.number,
        commit: entry.commit,
        ref: entry.ref ?? "",
        event: entry.event ?? "",
        status: entry.status ?? "",
        created: milliseconds(entry.created),
        finished: milliseconds(entry.finished),
      }));
    },
    pipeline: async (repository, number) => {
      const found = await read(`/api/repos/${repository}/pipelines/${number}`, PipelineJson);
      return {
        number: found.number,
        status: found.status,
        commit: found.commit,
        errors: errorsText(found.errors),
        created: milliseconds(found.created),
        started: milliseconds(found.started),
        finished: milliseconds(found.finished),
        workflows: (found.workflows ?? []).map((workflow) => ({
          name: workflow.name,
          state: workflow.state,
          agent: workflow.agent_id === undefined || workflow.agent_id === null || workflow.agent_id <= 0 ? null : workflow.agent_id,
          started: milliseconds(workflow.started),
          finished: milliseconds(workflow.finished),
          steps: (workflow.children ?? []).map((step) => ({ id: step.id, name: step.name, state: step.state, exitCode: step.exit_code ?? null })),
        })),
      };
    },
    config: async (repository, number) => (await read(`/api/repos/${repository}/pipelines/${number}/config`, ConfigJson.nullable()))?.map((entry) => entry.name) ?? [],
    log: async (repository, number, step) => {
      const lines = (await read(`/api/repos/${repository}/logs/${number}/${step}`, LogJson.nullable())) ?? [];
      return [...lines]
        .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
        .map((line) => Buffer.from(line.data ?? "", "base64").toString("utf8"))
        .join("\n");
    },
    pipelineUrl: (repository, number) => `${server}/repos/${repository}/pipeline/${number}`,
  };
}
