import { text } from "@super-agent2/catalog";
import { ticketReference } from "@super-agent2/protocol";
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
import { sharedUpdateRepository } from "./peer-exchange.js";
import type { MachineStore } from "./machines.js";
import { TicketError, type TicketService } from "./tickets.js";
import type { TicketTurn } from "./ticket-versions.js";
import type { AttachmentStore } from "./attachments.js";

export interface TaskTicketRequest {
  readonly title: GeneratedText;
  readonly summary: GeneratedText;
  readonly task: string;
  readonly kind: "writing" | "operation";
  readonly materials: readonly TaskMaterial[];
  readonly repository?: string | undefined;
  readonly project?: string | undefined;
  readonly commit?: string | undefined;
  readonly deploy?: boolean | undefined;
  readonly after?: readonly number[] | undefined;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
  readonly conversation?: string | undefined;
}

export type TaskOpenOutcome = { readonly ok: true; readonly ticket: Ticket; readonly notes: readonly string[] } | { readonly ok: false; readonly reason: string };

export interface PeerUpdate {
  readonly commit: string;
  readonly running: string;
  readonly previous?: { readonly commit: string; readonly ticket: number } | undefined;
  readonly record: (ticket: Ticket) => void;
}

export interface TaskTickets {
  open(request: TaskTicketRequest, turn?: TicketTurn): Promise<TaskOpenOutcome>;
  peerUpdate(update: PeerUpdate): Promise<"applied" | "ignored" | "retry">;
  ready(): void;
  refreshLocal(): void;
  pausesLocalWork(): boolean;
  resume(): void;
  idle(): Promise<void>;
  close(): void;
}

export interface LocalInstallation {
  readonly repository: string;
  readonly checkout: string;
  readonly commit: string;
  restart(commit: string): void;
}

export interface TaskTicketsOptions {
  readonly database: HubDatabase;
  readonly tickets: TicketService;
  readonly machines: MachineStore;
  readonly localInstallation?: LocalInstallation;
  readonly localIdle?: () => boolean;
  readonly tell?: import("./chains.js").Tell;
  readonly attachments?: AttachmentStore;
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

function requirePredecessor(ticket: Ticket | undefined): Ticket {
  if (ticket === undefined) {
    throw new TicketError(`the predecessor ticket could not be found.`);
  }
  if (ticket.light !== undefined) throw new TicketError("A ticket cannot depend on a light task.");
  if (ticket.state === "stopped") {
    throw new TicketError(ticket.repairedBy === null ? `ticket ${ticketReference(ticket)} has stopped, so nothing can come after it.` : `ticket ${ticketReference(ticket)} has stopped; ticket ${ticket.repairedByReference ?? "(unavailable)"} repairs it, so come after that.`);
  }
  return ticket;
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
  let localReady = false;
  let restartIssued = false;
  let checkingLocal: NodeJS.Immediate | undefined;

  const selectUndeployed = connection.prepare(
    "SELECT t.id AS id, v.merge_commit AS merge_commit FROM tickets t JOIN ticket_verifications v ON v.ticket_id = t.id WHERE t.form = 'code' AND t.state = 'merged' AND t.deployed_at IS NULL AND v.merge_commit IS NOT NULL AND t.repository = ? COLLATE NOCASE ORDER BY t.id",
  );
  const selectUnmarked = connection.prepare(
    "SELECT t.id AS id FROM tickets t JOIN ticket_tasks k ON k.ticket_id = t.id WHERE t.state = 'delivered' AND k.deploys = 1 AND t.deployed_at IS NULL ORDER BY t.id",
  );

  const selectLocal = connection.prepare(
    "SELECT t.id, k.commit_sha, k.local_restart FROM tickets t JOIN ticket_tasks k ON k.ticket_id = t.id WHERE t.state = 'delivered' AND t.deployed_at IS NULL AND k.local_build = 1 AND k.local_restart IS NOT 'failed' ORDER BY t.id",
  );
  const sameBuilds = connection.prepare(
    "SELECT t.id FROM tickets t JOIN ticket_tasks k ON k.ticket_id = t.id WHERE t.repository = ? COLLATE NOCASE AND t.state IN ('pending', 'waiting', 'working') AND k.local_build = 1 AND k.commit_ref IS ? ORDER BY t.id",
  );
  const setRestart = connection.prepare("UPDATE ticket_tasks SET local_restart = ? WHERE ticket_id = ?");
  const LocalBuild = IdRow.extend({
    commit_sha: z.string().nullable(),
    local_restart: z.enum(["waiting", "requested"]).nullable(),
  });
  const localBuilds = () => selectLocal.all().map((row) => LocalBuild.parse(row));
  const installation = options.localInstallation;

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

  const readTargets = async (repository: string, commit?: string): Promise<{ readonly targets: readonly string[]; readonly notes: string[] } | { readonly refused: string }> => {
    const gitHub = gitHubFor(repository);
    if (typeof gitHub === "string") {
      return { targets: [], notes: [`The deployment file could not be read (${gitHub}), so the ticket's machine follows its platform; its worker reads the file in its checkout and refuses to deploy on a machine the file does not name.`] };
    }
    try {
      const head = commit ?? await gitHub.commit(repository, "HEAD");
      const source = head === null ? null : await gitHub.fileText(repository, deploymentFile, head);
      if (source === null) {
        return {
          targets: [],
          notes: [
            `${repository} has no ${deploymentFile} on its default branch yet, so the ticket's machine follows its platform. Its worker reads the file at the commit it deploys and refuses to deploy on a machine the file does not name; if work arranged before it adds the file, that is the file it reads.`,
          ],
        };
      }
      const reading = readDeploymentFile(source);
      if (!reading.ok) {
        return { refused: `${deploymentFile} on the default branch of ${repository} is not a valid deployment file: ${reading.reason}. Have it corrected first, as ordinary work through a code ticket.` };
      }
      const targets = reading.file.target;
      return { targets, notes: [targets.length === 1
        ? `${deploymentFile} names the machine ${targets[0]} for this deployment.`
        : `${deploymentFile} allows this deployment on ${targets.join(", ")}. The hub chooses an available machine from that list, and the owner can choose one on the card.`] };
    } catch (error) {
      return { targets: [], notes: [`GitHub could not be read (${reasonOf(error)}), so the ticket's machine follows its platform; its worker reads the file in its checkout and refuses to deploy on a machine the file does not name.`] };
    }
  };

  const open = async (request: TaskTicketRequest, turn?: TicketTurn, peer?: PeerUpdate): Promise<TaskOpenOutcome> => {
    const refuse = (reason: string): TaskOpenOutcome => ({ ok: false, reason: `Nothing was opened: ${reason}` });
    const repository = request.repository ?? null;
    if (repository !== null && !RepositoryName.safeParse(repository).success) {
      return refuse(`${repository} is not a repository as owner/name.`);
    }
    if (request.project !== undefined && (repository !== null || !RepositoryName.safeParse(request.project).success)) {
      return refuse("use project as owner/name for a task without a checkout.");
    }
    if (repository === null && (request.commit !== undefined || request.deploy === true)) {
      return refuse("a commit or a deployment needs the repository it is of; name it in repository.");
    }
    if (request.deploy === true && request.kind !== "operation") {
      return refuse("a deployment is an operation; give kind operation.");
    }
    const after = [...new Set(request.after ?? [])];
    let before: Ticket[];
    try {
      before = after.map((id) => requirePredecessor(tickets.get(id)));
    } catch (error) {
      return refuse(reasonOf(error));
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
    const localBuild = request.deploy === true && installation !== undefined && sameRepository(repository, installation.repository);
    const notes: string[] = [];
    let targets: readonly string[] = [];
    if (localBuild) {
      notes.push(`This build updates the local edition on local. Its checkout is ${installation.checkout}, and it currently runs ${installation.commit}.`);
    } else if (request.deploy === true && repository !== null) {
      const read = await readTargets(repository, peer?.commit);
      if ("refused" in read) {
        return refuse(read.refused);
      }
      targets = read.targets;
      if (peer !== undefined && targets.length === 0) return refuse("The requested commit has no readable deployment recipe.");
      notes.push(...read.notes);
    }
    if (closed) {
      return refuse("the hub is stopping.");
    }
    try {
      if (targets.length > 0) {
        const registered = options.machines.list().filter((machine) => machine.revokedAt === null).map((machine) => machine.name);
        if (!targets.some((target) => registered.includes(target))) {
          return refuse(`${deploymentFile} for ${repository} names these deployment targets: ${targets.join(", ")}. This installation's registered machines: ${registered.join(", ") || "none"}. This deployment belongs to another installation. Tell the owner it must be arranged there.`);
        }
      }
      const ticket = tickets.change((writes) => {
        for (const id of after) {
          requirePredecessor(writes.get(id));
        }
        if (peer?.previous !== undefined) {
          const existing = writes.get(peer.previous.ticket);
          if (existing?.state === "pending" && existing.waits.length === 0 && existing.commit === peer.previous.commit) {
            writes.pinPendingCommit(existing.id, peer.commit, targets);
            const updated = writes.get(existing.id)!;
            peer.record(updated);
            return updated;
          }
        }
        if (localBuild && after.length > 0) {
          for (const row of sameBuilds.all(repository, commitRef)) {
            const existing = writes.get(IdRow.parse(row).id);
            if (existing?.waits.length === after.length && existing.waits.every((wait) => !wait.deployment && !wait.waived && after.includes(wait.ticket))) {
              notes.push("A local build ticket is already arranged after these chains.");
              return existing;
            }
          }
        }
        const id = writes.open({
          form: "task",
          repository,
          project: request.project,
          issues: [],
          title: request.title,
          summary: request.summary,
          kind: request.kind,
          difficulty: request.difficulty,
          platform: request.platform,
          requiredMachine: localBuild ? "local" : targets.length === 1 ? targets[0] : undefined,
          deploymentTargets: targets.length > 1 ? targets : undefined,
          conversation: request.conversation,
          waitsFor: after,
          task: { task: request.task, materials: request.materials, commitRef, deploys: request.deploy === true, localBuild: localBuild ? true : undefined },
        });
        if (peer !== undefined) {
          writes.pinPendingCommit(id, peer.commit);
          writes.state(id, {
            kind: "operation", difficulty: "mechanical", platform: "any",
            difficultyReason: { en: "Follow the installation's update procedure.", zh: "按照当前安装的更新流程执行。" },
          });
        }
        const opened = writes.get(id);
        if (opened === undefined) {
          throw new TicketError(`Ticket ${tickets.reference(id) ?? "(unavailable)"} was not stored`);
        }
        peer?.record(opened);
        options.attachments?.grant(id, request.materials.flatMap((piece) => piece.attachment == null ? [] : [piece.attachment]));
        return opened;
      }, turn);
      return { ok: true, ticket, notes };
    } catch (error) {
      return refuse(reasonOf(error));
    }
  };

  const peerUpdate = async (update: PeerUpdate): Promise<"applied" | "ignored" | "retry"> => {
    const repository = sharedUpdateRepository;
    const { commit, running, previous } = update;
    if (commit === running || commit === previous?.commit) return "ignored";
    const gitHub = gitHubFor(repository);
    if (typeof gitHub === "string") return "retry";

    const head = await gitHub.commit(repository, "HEAD");
    if (head === null) return "retry";
    if (commit !== head) {
      const onMain = await gitHub.compare(repository, commit, head);
      if (onMain === "unknown" || onMain === "behind") return "retry";
      if (onMain === "diverged") return "ignored";
    }

    const installed = await gitHub.compare(repository, running, commit);
    if (installed === "identical" || installed === "behind") return "ignored";
    if (installed === "unknown") return "retry";

    if (previous !== undefined && previous.commit !== running) {
      const order = await gitHub.compare(repository, previous.commit, commit);
      if (order === "unknown") return "retry";
      if (order !== "ahead") return "ignored";
    }

    const local = sameRepository(installation?.repository ?? null, repository);
    const request: TaskTicketRequest = {
      title: local ? { en: "Update the local edition (from NAS)", zh: "更新本地版（来自 NAS）" }
        : { en: "Deploy Super Agent (from local edition)", zh: "部署 Super Agent（来自本地版）" },
      summary: local ? { en: "Build the requested commit and restart the local edition.", zh: "构建请求的提交并重启本地版。" }
        : { en: "Apply the requested commit to the NAS.", zh: "将请求的提交部署到 NAS。" },
      task: local ? "Build and activate the requested commit on the local installation."
        : "Deploy the requested commit using the repository's deployment recipe.",
      repository, kind: "operation", deploy: true, commit, materials: [],
    };
    return (await open(request, undefined, update)).ok ? "applied" : "retry";
  };

  const mark = async (id: number) => {
    const ticket = tickets.get(id);
    if (ticket === undefined || !ticket.deploys || ticket.state !== "delivered" || ticket.deployedAt !== null || ticket.repository === null) {
      return;
    }
    const repository = ticket.repository;
    const commit = ticket.commit;
    const localBuild = ticket.localBuild === true;
    if (localBuild && (!localReady || commit === null || installation?.commit !== commit)) return;
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
        notes.push(`Whether ticket ${options.tickets.reference(candidate.id) ?? "(unavailable)"} (merge commit ${short(candidate.merge_commit)}) is in what was deployed could not be read: ${gitHub}.`);
        continue;
      }
      try {
        const relation = await gitHub.compare(repository, candidate.merge_commit, commit);
        if (relation === "ahead" || relation === "identical") {
          deployed.push(candidate.id);
        }
      } catch (error) {
        notes.push(`Whether ticket ${options.tickets.reference(candidate.id) ?? "(unavailable)"} (merge commit ${short(candidate.merge_commit)}) is in what was deployed could not be read: ${reasonOf(error)}.`);
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
    if (localBuild && commit !== null) {
      options.tell?.(id, text("notice.localBuildActivated", { ticket: ticket.code, commit: short(commit) }),
        `[hub] The local edition started on ${commit}. Ticket ${ticketReference(ticket)} is deployed, and work waiting for it can begin.`);
    }
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

  const refreshLocal = () => {
    if (closed || !localReady || installation === undefined || restartIssued || checkingLocal !== undefined) return;
    checkingLocal = setImmediate(() => {
      checkingLocal = undefined;
      for (const build of localBuilds()) {
        const ticket = tickets.get(build.id);
        if (ticket === undefined) continue;
        const commit = build.commit_sha;
        if (commit === installation.commit) {
          start(ticket.id);
          continue;
        }
        const failure = (reason: string) => {
          setRestart.run("failed", ticket.id);
          options.tell?.(ticket.id, text("notice.localBuildFailed", { ticket: ticket.code, commit: short(installation.commit) }),
            `[hub] The local edition is running ${installation.commit}. Ticket ${ticketReference(ticket)} expected ${commit ?? "a build commit"}. ${reason}`);
        };
        if (commit === null || build.local_restart === "requested") {
          failure(commit === null ? "The build reported no commit." : "The restart did not start the requested build.");
          continue;
        }
        if (options.localIdle?.() !== true) {
          if (build.local_restart === null) {
            setRestart.run("waiting", ticket.id);
            options.tell?.(ticket.id, text("notice.localBuildWaiting", { ticket: ticket.code }),
              `[hub] Ticket ${ticketReference(ticket)} built ${commit}. The local edition waits for its running work to finish before restarting.`);
          }
          return;
        }
        try {
          setRestart.run("requested", ticket.id);
          options.tell?.(ticket.id, text("notice.localBuildRestart", { ticket: ticket.code, commit: short(commit) }),
            `[hub] The local edition is restarting on ${commit} for ticket ${ticketReference(ticket)}.`);
          installation.restart(commit);
          restartIssued = true;
          return;
        } catch (error) {
          failure(reasonOf(error));
        }
      }
    });
  };

  const unsubscribe = tickets.subscribe((ticket) => {
    if (ticket.deploys && ticket.state === "delivered" && ticket.deployedAt === null) {
      if (ticket.localBuild === true) refreshLocal();
      else start(ticket.id);
    }
    refreshLocal();
  });

  return {
    open,
    peerUpdate,
    ready: () => {
      localReady = true;
      refreshLocal();
    },
    refreshLocal,
    pausesLocalWork: () => installation !== undefined && localBuilds().some((build) => !localReady || build.commit_sha !== installation.commit),
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
      clearImmediate(checkingLocal);
      unsubscribe();
    },
  };
}
