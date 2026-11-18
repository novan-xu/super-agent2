import type { GitHubAccount } from "@super-agent2/protocol";
import { text } from "@super-agent2/catalog";
import {
  type CommandEnvironment,
  type CommandRecord,
  Deployment,
  DeploymentFile,
  deploymentFile,
  type DeploymentOutcome,
  type DeploymentPhase,
  DeploymentResult,
  type DeploymentStepKind,
  deploymentVariables,
  finishedStates,
  readDeploymentFile,
  readDeploymentOutcome,
  RepositoryName,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { Tell } from "./chains.js";
import { type Clock, type Sleep, systemSleep } from "./clock.js";
import type { CommandService } from "./commands.js";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";
import { createGitHubApi, type Fetch, type GitHubApi } from "./github-api.js";
import { commandSummary, tail } from "./reports.js";

export interface DeploymentRequest {
  readonly repository: string;
  readonly commit: string;
  readonly previous?: string;
  readonly conversation?: string | null;
}

export type DeploymentStart = { readonly ok: true; readonly deployment: Deployment } | { readonly ok: false; readonly reason: string };

export type MarkDeployed = (ticket: number) => { readonly ok: boolean };

export interface DeploymentOptions {
  readonly accountOf?: (repository: string) => GitHubAccount;
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly commands: CommandService;
  readonly credentials: CredentialSource;
  readonly targets: () => readonly string[];
  readonly fetch?: Fetch;
  readonly gitHubBase?: string;
  readonly tell?: Tell;
  readonly deployed?: MarkDeployed;
  readonly sleep?: Sleep;
  readonly ownRepository?: string;
}

const nasHostName = "nas";

export interface DeploymentService {
  start(request: DeploymentRequest): Promise<DeploymentStart>;
  get(id: number): Deployment | undefined;
  latest(repository: string): Deployment | undefined;
  list(limit?: number): Deployment[];
  report(deployment: Deployment): string;
  resume(): void;
  idle(): Promise<void>;
  close(): void;
}

const DeploymentRow = z.object({
  id: z.number().int(),
  repository: z.string(),
  commit_sha: z.string(),
  previous: z.string().nullable(),
  target: z.string(),
  file: z.string(),
  conversation_id: z.string().nullable(),
  phase: z.string(),
  result: z.string().nullable(),
  reason: z.string().nullable(),
  notes: z.string(),
  health_from: z.number().int().nullable(),
  deployed_tickets: z.string(),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  told_at: z.number().int().nullable(),
});
type DeploymentRow = z.infer<typeof DeploymentRow>;

const StepRow = z.object({ seq: z.number().int(), kind: z.string(), command_id: z.string() });

const SeqRow = z.object({ seq: z.number().int().nullable() });

const UndeployedRow = z.object({ id: z.number().int(), merge_commit: z.string() });

const Notes = z.array(z.string());

const Tickets = z.array(z.number().int().positive());

type Ran = "ok" | "failed" | "not-run" | "interrupted";

export function short(commit: string): string {
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

function ran(record: CommandRecord | undefined): Ran {
  if (record === undefined) {
    return "not-run";
  }
  if (record.state === "exited") {
    return record.exitCode === 0 ? "ok" : "failed";
  }
  if (record.startedAt === null) {
    return "not-run";
  }
  return record.state === "interrupted" ? "interrupted" : "failed";
}

function ended(record: CommandRecord): string {
  if (record.state === "exited") {
    return `exited with code ${record.exitCode ?? "none"}`;
  }
  return `ended as ${record.state}${record.reason === null ? "" : ` (${record.reason})`}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const phaseWords: Readonly<Record<DeploymentPhase, string>> = {
  deploy: "running the deploy command",
  health: "checking the service's health",
  rollback: "running the rollback command",
  recheck: "checking health after the rollback",
  done: "done",
};

function noticeOf(deployment: Deployment): string {
  const repository = deployment.repository;
  const commit = short(deployment.commit);
  switch (deployment.result ?? "interrupted") {
    case "succeeded":
      return text("notice.deployment.succeeded", { repository, commit });
    case "rolled-back":
      return text("notice.deployment.rolledBack", { repository, commit, previous: deployment.previous === null ? "" : short(deployment.previous) });
    case "unrecovered":
      return text("notice.deployment.unrecovered", { repository, commit });
    case "failed":
      return text("notice.deployment.failed", { repository, commit });
    case "unchanged":
      return text("notice.deployment.unchanged", { repository, commit });
    case "not-run":
      return text("notice.deployment.notRun", { repository, commit });
    case "interrupted":
      return text("notice.deployment.interrupted", { repository, commit });
  }
}

export function deploymentEnvironment(deployment: Pick<Deployment, "id" | "repository" | "commit" | "previous">): CommandEnvironment {
  return {
    [deploymentVariables.repository]: deployment.repository,
    [deploymentVariables.commit]: deployment.commit,
    ...(deployment.previous === null ? {} : { [deploymentVariables.previous]: deployment.previous }),
    [deploymentVariables.deployment]: String(deployment.id),
  };
}

export function createDeployments(options: DeploymentOptions): DeploymentService {
  const { clock, commands } = options;
  const { connection } = options.database;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? systemSleep;
  const tell: Tell = options.tell ?? (() => undefined);
  const stopping = new AbortController();
  const drives = new Set<Promise<void>>();
  const preparing = new Set<string>();
  let closed = false;

  const selectRow = connection.prepare("SELECT * FROM deployments WHERE id = ?");
  const selectLatest = connection.prepare("SELECT * FROM deployments WHERE repository = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1");
  const selectRecent = connection.prepare("SELECT * FROM deployments ORDER BY id DESC LIMIT ?");
  const selectActive = connection.prepare("SELECT * FROM deployments WHERE repository = ? COLLATE NOCASE AND phase <> 'done' ORDER BY id LIMIT 1");
  const selectUnfinished = connection.prepare("SELECT * FROM deployments WHERE phase <> 'done' OR told_at IS NULL ORDER BY id");
  const selectSucceeded = connection.prepare(
    "SELECT * FROM deployments WHERE repository = ? COLLATE NOCASE AND result = 'succeeded' ORDER BY id DESC LIMIT 1",
  );
  const insertRow = connection.prepare(
    "INSERT INTO deployments (repository, commit_sha, previous, target, file, conversation_id, phase, started_at) VALUES (?, ?, ?, ?, ?, ?, 'deploy', ?)",
  );
  const selectSteps = connection.prepare("SELECT seq, kind, command_id FROM deployment_steps WHERE deployment_id = ? ORDER BY seq");
  const selectLastSeq = connection.prepare("SELECT MAX(seq) AS seq FROM deployment_steps WHERE deployment_id = ?");
  const insertStep = connection.prepare("INSERT INTO deployment_steps (deployment_id, seq, kind, command_id) VALUES (?, ?, ?, ?)");
  const selectUndeployed = connection.prepare(
    "SELECT t.id AS id, v.merge_commit AS merge_commit FROM tickets t JOIN ticket_verifications v ON v.ticket_id = t.id WHERE t.state = 'merged' AND t.deployed_at IS NULL AND v.merge_commit IS NOT NULL AND t.repository = ? COLLATE NOCASE ORDER BY t.id",
  );

  const toDeployment = (row: DeploymentRow): Deployment =>
    Deployment.parse({
      id: row.id,
      repository: row.repository,
      commit: row.commit_sha,
      previous: row.previous,
      target: row.target,
      file: JSON.parse(row.file),
      conversation: row.conversation_id,
      phase: row.phase,
      result: row.result,
      reason: row.reason,
      notes: Notes.parse(JSON.parse(row.notes)),
      deployedTickets: Tickets.parse(JSON.parse(row.deployed_tickets)),
      steps: selectSteps.all(row.id).map((step) => {
        const value = StepRow.parse(step);
        return { seq: value.seq, kind: value.kind, command: value.command_id };
      }),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    });

  const rowOf = (id: number): DeploymentRow | undefined => {
    const row = selectRow.get(id);
    return row === undefined ? undefined : DeploymentRow.parse(row);
  };

  const get = (id: number): Deployment | undefined => {
    const row = rowOf(id);
    return row === undefined ? undefined : toDeployment(row);
  };

  const update = (id: number, fields: Readonly<Record<string, string | number | null>>) => {
    if (closed) {
      return;
    }
    const names = Object.keys(fields);
    connection.prepare(`UPDATE deployments SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`).run(...names.map((name) => fields[name] ?? null), id);
  };

  const note = (id: number, words: string) => {
    const row = rowOf(id);
    if (row !== undefined) {
      update(id, { notes: JSON.stringify([...Notes.parse(JSON.parse(row.notes)), words]) });
    }
  };

  const gitHubFor = (repository: string): GitHubApi | string => {
    const found = options.credentials((options.accountOf ?? accountFor)(repository));
    if (!found.ok) {
      return found.reason;
    }
    const token = found.credentials["GH_TOKEN"];
    if (token === undefined || token === "") {
      return `There is no GitHub token for ${repository}`;
    }
    return createGitHubApi({ fetch: doFetch, token, ...(options.gitHubBase === undefined ? {} : { base: options.gitHubBase }) });
  };

  const runStep = (deployment: Deployment, kind: DeploymentStepKind, command: string): string => {
    const started = commands.start({
      target: deployment.target,
      command,
      account: (options.accountOf ?? accountFor)(deployment.repository),
      ...(deployment.file.folder === undefined ? {} : { cwd: deployment.file.folder }),
      environment: deploymentEnvironment(deployment),
    });
    const seq = (SeqRow.parse(selectLastSeq.get(deployment.id)).seq ?? 0) + 1;
    insertStep.run(deployment.id, seq, kind, started.id);
    return started.id;
  };

  const settle = (id: string, signal: AbortSignal): Promise<CommandRecord | undefined> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (record: CommandRecord | undefined) => {
        if (done) {
          return;
        }
        done = true;
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        resolve(record);
      };
      const onAbort = () => finish(undefined);
      const unsubscribe = commands.subscribe((event) => {
        if (event.type === "command" && event.command.id === id && finishedStates.includes(event.command.state)) {
          finish(event.command);
        }
      });
      signal.addEventListener("abort", onAbort, { once: true });
      const current = commands.get(id);
      if (signal.aborted) {
        onAbort();
      } else if (current === undefined || finishedStates.includes(current.state)) {
        finish(current);
      }
    });

  const settleWithin = async (id: string, limit: number): Promise<CommandRecord | undefined> => {
    const timer = new AbortController();
    const stop = () => timer.abort();
    stopping.signal.addEventListener("abort", stop, { once: true });
    const finished = settle(id, stopping.signal).then((record) => {
      timer.abort();
      return record;
    });
    await sleep(limit, timer.signal);
    stopping.signal.removeEventListener("abort", stop);
    if (!closed) {
      const current = commands.get(id);
      if (current !== undefined && !finishedStates.includes(current.state)) {
        commands.stop(id);
      }
    }
    return finished;
  };

  const tellResult = (id: number) => {
    const row = rowOf(id);
    if (closed || row === undefined || row.phase !== "done" || row.told_at !== null) {
      return;
    }
    update(id, { told_at: clock.now() });
    const deployment = toDeployment(row);
    tell(deployment.conversation, noticeOf(deployment), [`[hub] ${report(deployment)}`, followUp(deployment.result ?? "interrupted")].join("\n"));
  };

  const end = (id: number, result: DeploymentResult, reason: string) => {
    update(id, { phase: "done", result, reason, ended_at: clock.now() });
    tellResult(id);
  };

  const enter = (id: number, phase: "health" | "recheck" | "rollback") => {
    update(id, { phase, health_from: phase === "rollback" ? null : clock.now() });
  };

  const included = async (deployment: Deployment): Promise<number[]> => {
    const candidates = selectUndeployed.all(deployment.repository).map((row) => UndeployedRow.parse(row));
    if (candidates.length === 0) {
      return [];
    }
    const gitHub = gitHubFor(deployment.repository);
    const found: number[] = [];
    for (const candidate of candidates) {
      if (candidate.merge_commit === deployment.commit) {
        found.push(candidate.id);
        continue;
      }
      if (typeof gitHub === "string") {
        note(deployment.id, `Whether ticket ${candidate.id} (merge commit ${short(candidate.merge_commit)}) is included could not be read: ${gitHub}`);
        continue;
      }
      try {
        const relation = await gitHub.compare(deployment.repository, candidate.merge_commit, deployment.commit);
        if (relation === "ahead" || relation === "identical") {
          found.push(candidate.id);
        }
      } catch (error) {
        note(deployment.id, `Whether ticket ${candidate.id} (merge commit ${short(candidate.merge_commit)}) is included could not be read: ${reasonOf(error)}`);
      }
    }
    return found;
  };

  const succeed = async (id: number, reason = "The service passed its health check after the deploy command.") => {
    const deployment = get(id);
    if (deployment === undefined) {
      return;
    }
    const tickets = await included(deployment);
    if (closed) {
      return;
    }
    const marked = tickets.filter((ticket) => options.deployed?.(ticket).ok ?? false);
    update(id, { deployed_tickets: JSON.stringify(marked) });
    end(id, "succeeded", reason);
  };

  const outcomeOf = (command: string): DeploymentOutcome | undefined =>
    readDeploymentOutcome(
      commands
        .output(command)
        .filter((chunk) => chunk.stream === "stdout")
        .map((chunk) => chunk.data)
        .join(""),
    );

  const stepWords: Readonly<Record<DeploymentStepKind, string>> = {
    deploy: "deploy command",
    health: "health check",
    rollback: "rollback command",
    recheck: "health check after the rollback",
  };

  const reported = async (deployment: Deployment, kind: DeploymentStepKind, outcome: DeploymentOutcome) => {
    note(deployment.id, `The ${stepWords[kind]} reported how the deployment ended: ${outcome.result}.`);
    if (outcome.previous !== undefined && deployment.previous === null) {
      update(deployment.id, { previous: outcome.previous });
    }
    if (outcome.result === "succeeded") {
      await succeed(deployment.id, outcome.reason);
      return;
    }
    end(deployment.id, outcome.result, outcome.reason);
  };

  const probe = async (deployment: Deployment, why: string) => {
    note(deployment.id, `${why} The health check ran once to read whether the deployment reported how it ended.`);
    const id = runStep(deployment, "health", deployment.file.health.command);
    await settleWithin(id, deployment.file.health.withinSeconds * 1000);
    if (closed) {
      return;
    }
    const outcome = outcomeOf(id);
    if (outcome !== undefined) {
      await reported(deployment, "health", outcome);
      return;
    }
    end(deployment.id, "interrupted", `${why} The health check reported no outcome, so whether it finished is not known, and nothing was rolled back.`);
  };

  const commandPhase = async (deployment: Deployment, kind: "deploy" | "rollback") => {
    const step = deployment.steps.filter((entry) => entry.kind === kind).at(-1);
    if (step === undefined) {
      end(deployment.id, "interrupted", `The hub restarted before it recorded the ${kind} command; whether it started is not known, and nothing more was run.`);
      return;
    }
    const record = await settle(step.command, stopping.signal);
    if (closed || record === undefined) {
      return;
    }
    const told = outcomeOf(step.command);
    if (told !== undefined) {
      await reported(deployment, kind, told);
      return;
    }
    const outcome = ran(record);
    if (kind === "deploy") {
      if (outcome === "ok") {
        enter(deployment.id, "health");
        return;
      }
      if (outcome === "not-run") {
        end(deployment.id, "not-run", `The deploy command did not run: it ${ended(record)}. Nothing was changed.`);
        return;
      }
      if (outcome === "interrupted") {
        await probe(deployment, `The deploy command was interrupted while it ran (${record.reason ?? "no reason recorded"}).`);
        return;
      }
      fail(deployment, `The deploy command ${ended(record)}.`);
      return;
    }
    if (outcome === "ok") {
      enter(deployment.id, "recheck");
      return;
    }
    if (outcome === "interrupted") {
      end(deployment.id, "interrupted", `The rollback command was interrupted while it ran (${record.reason ?? "no reason recorded"}); whether the previous version is back is not known.`);
      return;
    }
    end(deployment.id, "unrecovered", outcome === "not-run" ? `The rollback command did not run: it ${ended(record)}.` : `The rollback command ${ended(record)}.`);
  };

  const fail = (deployment: Deployment, why: string) => {
    note(deployment.id, why);
    if (deployment.previous === null) {
      end(deployment.id, "failed", `${why} There is no earlier deployment of ${deployment.repository} recorded by the hub, so there is no previous version to roll back to, and nothing was rolled back.`);
      return;
    }
    enter(deployment.id, "rollback");
    runStep(deployment, "rollback", deployment.file.rollback);
  };

  const healthPhase = async (deployment: Deployment, kind: "health" | "recheck", resumed: boolean) => {
    const row = rowOf(deployment.id);
    if (row === undefined) {
      return;
    }
    let from = row.health_from ?? clock.now();
    if (resumed) {
      from = clock.now();
      update(deployment.id, { health_from: from });
      note(deployment.id, `The hub restarted during the health check${kind === "recheck" ? " after the rollback" : ""}; the check started again with a full period.`);
    }
    const every = deployment.file.health.everySeconds * 1000;
    const within = deployment.file.health.withinSeconds * 1000;
    const deadline = from + within;
    let healthy = false;
    for (;;) {
      if (closed) {
        return;
      }
      const started = clock.now();
      const id = runStep(deployment, kind, deployment.file.health.command);
      const record = await settleWithin(id, Math.max(deadline, started + every) - started);
      if (closed) {
        return;
      }
      const told = outcomeOf(id);
      if (told !== undefined) {
        await reported(deployment, kind, told);
        return;
      }
      if (record?.state === "exited" && record.exitCode === 0) {
        healthy = true;
        break;
      }
      if (clock.now() >= deadline) {
        break;
      }
      const pause = Math.min(started + every, deadline) - clock.now();
      if (pause > 0) {
        await sleep(pause, stopping.signal);
      }
    }
    const seconds = deployment.file.health.withinSeconds;
    if (kind === "health") {
      if (healthy) {
        await succeed(deployment.id);
        return;
      }
      fail(deployment, `The service did not pass its health check within ${seconds} seconds.`);
      return;
    }
    if (healthy) {
      end(deployment.id, "rolled-back", `The deployment failed and was rolled back to ${deployment.previous ?? "the previous commit"}, which passes its health check again.`);
      return;
    }
    end(deployment.id, "unrecovered", `The rollback command finished, but the service still did not pass its health check within ${seconds} seconds.`);
  };

  const drive = async (id: number, resumed: boolean) => {
    let first = resumed;
    for (;;) {
      if (closed) {
        return;
      }
      const deployment = get(id);
      if (deployment === undefined) {
        return;
      }
      const before = `${deployment.phase}:${deployment.steps.length}:${deployment.result ?? ""}`;
      switch (deployment.phase) {
        case "done":
          tellResult(id);
          return;
        case "deploy":
        case "rollback":
          await commandPhase(deployment, deployment.phase);
          break;
        case "health":
        case "recheck":
          await healthPhase(deployment, deployment.phase, first);
          break;
      }
      first = false;
      const after = get(id);
      if (after === undefined || `${after.phase}:${after.steps.length}:${after.result ?? ""}` === before) {
        return;
      }
    }
  };

  const launch = (id: number, resumed: boolean) => {
    const running: Promise<void> = drive(id, resumed)
      .catch((error: unknown) => {
        if (!closed) {
          end(id, "interrupted", `The hub failed while it ran the deployment: ${reasonOf(error)}. What ran is in its steps.`);
        }
      })
      .finally(() => {
        drives.delete(running);
      });
    drives.add(running);
  };

  const commandText = (id: string, limit: number): string[] => {
    const record = commands.get(id);
    if (record === undefined) {
      return [`Command ${id} is not recorded.`];
    }
    const output = commands
      .output(id)
      .map((chunk) => chunk.data)
      .join("");
    return [
      `${commandSummary(record)}${record.reason === null ? "" : ` Reason: ${record.reason}`}`,
      ...(record.state === "held" ? ["It is held until the owner confirms it on the web page; the deployment waits for it."] : []),
      output === "" ? "Output: (none)" : `Output${output.length > limit ? ", its end" : ""}:\n${tail(output, limit)}`,
    ];
  };

  const resultWords = (deployment: Deployment): string => {
    switch (deployment.result) {
      case "succeeded":
        return "succeeded: the service passed its health check";
      case "rolled-back":
        return `failed and was rolled back to ${deployment.previous ?? "the previous commit"}; the previous version passes its health check again`;
      case "unrecovered":
        return "failed, and the rollback did not bring the service back";
      case "failed":
        return "failed, and nothing was rolled back";
      case "unchanged":
        return "failed before it replaced anything; the version that ran before still runs";
      case "not-run":
        return "did not run";
      case "interrupted":
        return "was interrupted; its outcome is not known";
      case null:
        return `is running: ${phaseWords[deployment.phase]}`;
    }
  };

  const report = (deployment: Deployment): string => {
    const lines = [
      `Deployment ${deployment.id} of ${deployment.repository} at commit ${deployment.commit} on target ${deployment.target} ${resultWords(deployment)}.`,
      `Previously deployed commit: ${deployment.previous ?? "none recorded"}. Started ${new Date(deployment.startedAt).toISOString()}${deployment.endedAt === null ? "" : `, ended ${new Date(deployment.endedAt).toISOString()}`}.`,
    ];
    if (deployment.reason !== null) {
      lines.push(`Why: ${deployment.reason}`);
    }
    for (const words of deployment.notes) {
      lines.push(`Note: ${words}`);
    }
    if (deployment.result === "succeeded") {
      lines.push(
        deployment.deployedTickets.length === 0
          ? "No merged ticket waited to be marked deployed by it."
          : `Marked deployed: ${deployment.deployedTickets.map((ticket) => `ticket ${ticket}`).join(", ")}; the tickets that waited for their deployment begin by themselves.`,
      );
    }
    const steps = deployment.steps;
    steps.forEach((step, index) => {
      const checks = step.kind === "health" || step.kind === "recheck";
      if (checks && steps[index + 1]?.kind === step.kind) {
        return;
      }
      if (checks) {
        const count = steps.filter((entry) => entry.kind === step.kind).length;
        lines.push(`${step.kind === "health" ? "Health check" : "Health check after the rollback"} (${count} run${count === 1 ? "" : "s"}), the last one:`, ...commandText(step.command, 2_000));
        return;
      }
      lines.push(`${step.kind === "deploy" ? "Deploy command" : "Rollback command"}:`, ...commandText(step.command, 6_000));
    });
    return lines.join("\n");
  };

  const followUp = (result: DeploymentResult): string => {
    switch (result) {
      case "succeeded":
        return "Tell the owner in Chinese, in a line or two.";
      case "rolled-back":
        return "Tell the owner in Chinese, in a line or two, what failed and that the previous version answers again. Find the cause before deploying again.";
      default:
        return "Tell the owner in Chinese what happened, and check the service yourself with run_command (its health check command) before deciding what to do next.";
    }
  };

  const activeOf = (repository: string): Deployment | undefined => {
    const row = selectActive.get(repository);
    return row === undefined ? undefined : toDeployment(DeploymentRow.parse(row));
  };

  const busy = (deployment: Deployment) =>
    `Deployment ${deployment.id} of ${deployment.repository} at ${short(deployment.commit)} is still running (${phaseWords[deployment.phase]}); one deployment per repository at a time. Read it with read_deployment; nothing new was started.`;

  const start = async (request: DeploymentRequest): Promise<DeploymentStart> => {
    const named = RepositoryName.safeParse(request.repository);
    if (!named.success) {
      return { ok: false, reason: `${request.repository} is not a repository as owner/name.` };
    }
    const repository = named.data;
    const key = repository.toLowerCase();
    if (options.ownRepository !== undefined && key === options.ownRepository.toLowerCase()) {
      return {
        ok: false,
        reason: `${repository} is Super-agent2 itself, which the hub does not deploy: the hub cannot reach the NAS host it runs on. It is deployed on the NAS by hand, or by a worker when the owner files work for it. Nothing was deployed. Tell the owner the new version is merged and waits to be deployed; once the owner says it is deployed, report it with report_deployment.`,
      };
    }
    if (closed) {
      return { ok: false, reason: "The hub is stopping; nothing was deployed." };
    }
    const running = activeOf(repository);
    if (running !== undefined) {
      return { ok: false, reason: busy(running) };
    }
    if (preparing.has(key)) {
      return { ok: false, reason: `Another deployment of ${repository} is being prepared; one deployment per repository at a time. Nothing new was started.` };
    }
    preparing.add(key);
    try {
      const gitHub = gitHubFor(repository);
      if (typeof gitHub === "string") {
        return { ok: false, reason: `${gitHub}; nothing was deployed.` };
      }
      let commit: string | null;
      let source: string | null;
      try {
        commit = await gitHub.commit(repository, request.commit);
        source = commit === null ? null : await gitHub.fileText(repository, deploymentFile, commit);
      } catch (error) {
        return { ok: false, reason: `GitHub could not be read: ${reasonOf(error)}; nothing was deployed.` };
      }
      if (commit === null) {
        return { ok: false, reason: `There is no commit ${request.commit} in ${repository}; nothing was deployed.` };
      }
      if (source === null) {
        return {
          ok: false,
          reason: `${repository} has no ${deploymentFile} at ${short(commit)}, so it declares no deployment; nothing was deployed. A repository that should be deployed needs that file first, added as ordinary work through a ticket.`,
        };
      }
      const reading = readDeploymentFile(source);
      if (!reading.ok) {
        return { ok: false, reason: `${deploymentFile} at ${short(commit)} is not a valid deployment file: ${reading.reason}. Nothing was deployed.` };
      }
      const file = reading.file;
      if (file.target === nasHostName) {
        return {
          ok: false,
          reason: `${deploymentFile} at ${short(commit)} names the target ${nasHostName}, the NAS host, which the hub cannot reach: no target runs there. Deploying on the NAS host is out of scope until the owner sets up a way for it deliberately. Nothing was deployed.`,
        };
      }
      const targets = options.targets();
      if (!targets.includes(file.target)) {
        return { ok: false, reason: `${deploymentFile} at ${short(commit)} names the target ${file.target}, which the hub does not know (targets now: ${targets.join(", ")}). Nothing was deployed.` };
      }
      if (closed) {
        return { ok: false, reason: "The hub is stopping; nothing was deployed." };
      }
      const again = activeOf(repository);
      if (again !== undefined) {
        return { ok: false, reason: busy(again) };
      }
      const succeeded = selectSucceeded.get(repository);
      const previous = succeeded === undefined ? (request.previous ?? null) : DeploymentRow.parse(succeeded).commit_sha;
      const inserted = insertRow.run(repository, commit, previous, file.target, JSON.stringify(DeploymentFile.parse(file)), request.conversation ?? null, clock.now());
      const id = Number(inserted.lastInsertRowid);
      const created = get(id);
      if (created === undefined) {
        throw new Error(`Deployment ${id} was not stored`);
      }
      runStep(created, "deploy", file.deploy);
      launch(id, false);
      return { ok: true, deployment: get(id) ?? created };
    } finally {
      preparing.delete(key);
    }
  };

  return {
    start,
    get,
    latest: (repository) => {
      const row = selectLatest.get(repository);
      return row === undefined ? undefined : toDeployment(DeploymentRow.parse(row));
    },
    list: (limit = 20) => selectRecent.all(limit).map((row) => toDeployment(DeploymentRow.parse(row))),
    report,
    resume: () => {
      for (const row of selectUnfinished.all().map((value) => DeploymentRow.parse(value))) {
        if (row.phase === "done") {
          tellResult(row.id);
        } else {
          launch(row.id, true);
        }
      }
    },
    idle: async () => {
      while (drives.size > 0) {
        await Promise.all([...drives]);
      }
    },
    close: () => {
      closed = true;
      stopping.abort();
    },
  };
}
