import type { GitHubAccount } from "@super-agent2/protocol";
import {
  CommitRef,
  type Difficulty,
  type GeneratedText,
  deploymentFile,
  mergedCommit,
  type Platform,
  RepositoryName,
  readDeploymentFile,
  type TaskMaterial,
  type Ticket,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { CredentialSource } from "./credentials.js";
import type { HubDatabase } from "./database.js";
import { accountFor } from "./filing.js";
import { createGitHubApi, type Fetch, type GitHubApi } from "./github-api.js";
import { TicketError, type TicketService } from "./tickets.js";

export interface TaskTicketRequest {
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly task: string;
  readonly kind: "writing" | "operation";
  readonly materials: readonly TaskMaterial[];
  readonly repository?: string | undefined;
  readonly commit?: string | undefined;
  readonly deploy?: boolean | undefined;
  readonly after?: readonly number[] | undefined;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
  readonly conversation?: string | undefined;
}

export type TaskOpenOutcome = { readonly ok: true; readonly ticket: Ticket; readonly notes: readonly string[] } | { readonly ok: false; readonly reason: string };

export interface TaskTickets {
  open(request: TaskTicketRequest): Promise<TaskOpenOutcome>;
  resume(): void;
  idle(): Promise<void>;
  close(): void;
}

export interface TaskTicketsOptions {
  readonly database: HubDatabase;
  readonly tickets: TicketService;
  readonly credentials: CredentialSource;
  readonly fetch?: Fetch;
  readonly gitHubBase?: string;
  readonly accountOf?: (repository: string) => GitHubAccount;
  readonly marked?: (ticket: Ticket, deployed: readonly number[], notes: readonly string[]) => void;
}

const UndeployedRow = z.object({ id: z.number().int(), merge_commit: z.string() });

const IdRow = z.object({ id: z.number().int() });

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function short(commit: string): string {
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

function sameRepository(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

export function finalMergeCommit(ticket: Ticket): string | null {
  return ticket.verification?.mergeCommit ?? ticket.pullRequests.filter((pull) => pull.state === "merged").at(-1)?.mergeCommit ?? null;
}

function mergedAt(ticket: Ticket): number {
  return ticket.pullRequests.filter((pull) => pull.state === "merged").at(-1)?.mergedAt ?? ticket.endedAt ?? 0;
}

export function chainsBefore(ticket: Pick<Ticket, "waits" | "repository">, get: (id: number) => Ticket | undefined): Ticket[] {
  return ticket.waits.flatMap((wait) => {
    const before = get(wait.ticket);
    return before !== undefined && before.form === "code" && sameRepository(before.repository, ticket.repository) ? [before] : [];
  });
}

export function mergedCommitFor(ticket: Ticket, get: (id: number) => Ticket | undefined): string | null {
  const merged = chainsBefore(ticket, get)
    .filter((before) => before.state === "merged" && finalMergeCommit(before) !== null)
    .sort((a, b) => mergedAt(b) - mergedAt(a) || b.id - a.id);
  const latest = merged[0];
  return latest === undefined ? null : finalMergeCommit(latest);
}

export function createTaskTickets(options: TaskTicketsOptions): TaskTickets {
  const { tickets } = options;
  const { connection } = options.database;
  const doFetch = options.fetch ?? fetch;
  const marking = new Set<number>();
  const running = new Set<Promise<void>>();
  let closed = false;

  const selectUndeployed = connection.prepare(
    "SELECT t.id AS id, v.merge_commit AS merge_commit FROM tickets t JOIN ticket_verifications v ON v.ticket_id = t.id WHERE t.form = 'code' AND t.state = 'merged' AND t.deployed_at IS NULL AND v.merge_commit IS NOT NULL AND t.repository = ? COLLATE NOCASE ORDER BY t.id",
  );
  const selectUnmarked = connection.prepare(
    "SELECT t.id AS id FROM tickets t JOIN ticket_tasks k ON k.ticket_id = t.id WHERE t.state = 'delivered' AND k.deploys = 1 AND t.deployed_at IS NULL ORDER BY t.id",
  );

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

  const readTarget = async (repository: string): Promise<{ readonly target: string | null; readonly notes: string[] } | { readonly refused: string }> => {
    const gitHub = gitHubFor(repository);
    if (typeof gitHub === "string") {
      return { target: null, notes: [`The deployment file could not be read (${gitHub}), so the ticket's machine follows its platform; its worker reads the file in its checkout and refuses to deploy on a machine the file does not name.`] };
    }
    try {
      const head = await gitHub.commit(repository, "HEAD");
      const source = head === null ? null : await gitHub.fileText(repository, deploymentFile, head);
      if (source === null) {
        return {
          target: null,
          notes: [
            `${repository} has no ${deploymentFile} on its default branch yet, so the ticket's machine follows its platform. Its worker reads the file at the commit it deploys and refuses to deploy on a machine the file does not name; if work arranged before it adds the file, that is the file it reads.`,
          ],
        };
      }
      const reading = readDeploymentFile(source);
      if (!reading.ok) {
        return { refused: `${deploymentFile} on the default branch of ${repository} is not a valid deployment file: ${reading.reason}. Have it corrected first, as ordinary work through a code ticket.` };
      }
      return { target: reading.file.target, notes: [`${deploymentFile} names the machine ${reading.file.target}: the ticket runs there, and only there.`] };
    } catch (error) {
      return { target: null, notes: [`GitHub could not be read (${reasonOf(error)}), so the ticket's machine follows its platform; its worker reads the file in its checkout and refuses to deploy on a machine the file does not name.`] };
    }
  };

  const open = async (request: TaskTicketRequest): Promise<TaskOpenOutcome> => {
    const refuse = (reason: string): TaskOpenOutcome => ({ ok: false, reason: `Nothing was opened: ${reason}` });
    const repository = request.repository ?? null;
    if (repository !== null && !RepositoryName.safeParse(repository).success) {
      return refuse(`${repository} is not a repository as owner/name.`);
    }
    if (repository === null && (request.commit !== undefined || request.deploy === true)) {
      return refuse("a commit or a deployment needs the repository it is of; name it in repository.");
    }
    if (request.deploy === true && request.kind !== "operation") {
      return refuse("a deployment is an operation; give kind operation.");
    }
    const after = [...new Set(request.after ?? [])];
    const before: Ticket[] = [];
    for (const id of after) {
      const found = tickets.get(id);
      if (found === undefined) {
        return refuse(`there is no ticket ${id} to come after.`);
      }
      if (found.state === "stopped") {
        return refuse(found.repairedBy === null ? `ticket ${id} has stopped, so nothing can come after it.` : `ticket ${id} has stopped; ticket ${found.repairedBy} repairs it, so come after that.`);
      }
      before.push(found);
    }
    const chains = before.filter((ticket) => ticket.form === "code" && sameRepository(ticket.repository, repository));
    let commitRef: string | null = null;
    if (request.commit !== undefined) {
      if (request.commit === mergedCommit) {
        if (chains.length === 0) {
          return refuse(`commit "${mergedCommit}" means the final merge commit of a code chain of ${repository ?? "the repository"} it comes after; name that chain's ticket in after.`);
        }
        commitRef = mergedCommit;
      } else {
        const parsed = CommitRef.safeParse(request.commit);
        if (!parsed.success) {
          return refuse(`${request.commit} is not a commit, a branch or "${mergedCommit}".`);
        }
        commitRef = parsed.data;
      }
    } else if (request.deploy === true && chains.length > 0) {
      commitRef = mergedCommit;
    }
    const notes: string[] = [];
    let requiredMachine: string | null = null;
    if (request.deploy === true && repository !== null) {
      const read = await readTarget(repository);
      if ("refused" in read) {
        return refuse(read.refused);
      }
      requiredMachine = read.target;
      notes.push(...read.notes);
    }
    if (closed) {
      return refuse("the hub is stopping.");
    }
    try {
      const ticket = tickets.change((writes) => {
        const id = writes.open({
          form: "task",
          repository,
          issues: [],
          title: request.title,
          summary: request.summary,
          kind: request.kind,
          difficulty: request.difficulty,
          platform: request.platform,
          requiredMachine,
          conversation: request.conversation,
          waitsFor: after,
          task: { task: request.task, materials: request.materials, commitRef, deploys: request.deploy === true },
        });
        const opened = writes.get(id);
        if (opened === undefined) {
          throw new TicketError(`Ticket ${id} was not stored`);
        }
        return opened;
      });
      return { ok: true, ticket, notes };
    } catch (error) {
      return refuse(reasonOf(error));
    }
  };

  const mark = async (id: number) => {
    const ticket = tickets.get(id);
    if (ticket === undefined || !ticket.deploys || ticket.state !== "delivered" || ticket.deployedAt !== null || ticket.repository === null) {
      return;
    }
    const repository = ticket.repository;
    const commit = ticket.commit;
    const candidates = selectUndeployed.all(repository).map((row) => UndeployedRow.parse(row));
    const notes: string[] = [];
    const direct = chainsBefore(ticket, tickets.get).filter((before) => before.state === "merged" && before.deployedAt === null);
    const deployed: number[] = direct.map((before) => before.id);
    const included = (candidate: z.infer<typeof UndeployedRow>) => candidate.merge_commit === commit || deployed.includes(candidate.id);
    const gitHub = commit !== null && candidates.some((candidate) => !included(candidate)) ? gitHubFor(repository) : undefined;
    for (const candidate of candidates) {
      if (closed) {
        return;
      }
      if (included(candidate)) {
        if (!deployed.includes(candidate.id)) {
          deployed.push(candidate.id);
        }
        continue;
      }
      if (commit === null || gitHub === undefined) {
        continue;
      }
      if (typeof gitHub === "string") {
        notes.push(`Whether ticket ${candidate.id} (merge commit ${short(candidate.merge_commit)}) is in what was deployed could not be read: ${gitHub}.`);
        continue;
      }
      try {
        const relation = await gitHub.compare(repository, candidate.merge_commit, commit);
        if (relation === "ahead" || relation === "identical") {
          deployed.push(candidate.id);
        }
      } catch (error) {
        notes.push(`Whether ticket ${candidate.id} (merge commit ${short(candidate.merge_commit)}) is in what was deployed could not be read: ${reasonOf(error)}.`);
      }
    }
    if (closed) {
      return;
    }
    tickets.change((writes) => {
      for (const done of deployed) {
        writes.deployed(done);
      }
      writes.deployed(id);
    });
    options.marked?.(tickets.get(id) ?? ticket, deployed, notes);
  };

  const start = (id: number) => {
    if (closed || marking.has(id)) {
      return;
    }
    marking.add(id);
    const task: Promise<void> = mark(id)
      .catch(() => undefined)
      .finally(() => {
        marking.delete(id);
        running.delete(task);
      });
    running.add(task);
  };

  const unsubscribe = tickets.subscribe((ticket) => {
    if (ticket.deploys && ticket.state === "delivered" && ticket.deployedAt === null) {
      start(ticket.id);
    }
  });

  return {
    open,
    resume: () => {
      for (const row of selectUnmarked.all()) {
        start(IdRow.parse(row).id);
      }
    },
    idle: async () => {
      while (running.size > 0) {
        await Promise.all([...running]);
      }
    },
    close: () => {
      closed = true;
      unsubscribe();
    },
  };
}
