import { createHash } from "node:crypto";
import { text } from "@super-agent2/catalog";
import {
  arrangedAfter,
  canStartAlone,
  cardKey,
  type ChainNode,
  type ChainStartItem,
  type Difficulty,
  difficulties,
  findCycle,
  GeneratedText,
  inWorkingOrder,
  indexOf,
  type Platform,
  RepositoryName,
  readyToBegin,
  type StartCard,
  startGaps,
  type Ticket,
  type TicketIssue,
  type TicketKind,
  unmetWaits,
  waitEdges,
} from "@super-agent2/protocol";
import { z } from "zod";
import type { AccessVerifier } from "./access.js";
import type { Clock } from "./clock.js";
import type { HubDatabase } from "./database.js";
import { TicketError, type TicketService, type TicketWork, type WaitToSet } from "./tickets.js";

export interface ChainSpec {
  readonly name: string;
  readonly repository: string;
  readonly issues: readonly number[];
  readonly after?: readonly (string | number)[] | undefined;
  readonly afterDeployment?: boolean | undefined;
  readonly title?: GeneratedText | undefined;
  readonly summary?: GeneratedText | undefined;
  readonly kind?: TicketKind | undefined;
  readonly difficulty?: Difficulty | undefined;
  readonly platform?: Platform | undefined;
}

export interface ArrangedChain {
  readonly name: string;
  readonly ticket: Ticket;
}

export type ArrangeOutcome =
  | { readonly ok: true; readonly chains: readonly ArrangedChain[]; readonly joined: readonly number[] }
  | { readonly ok: false; readonly reason: string };

export type TicketOutcome = { readonly ok: true; readonly ticket: Ticket; readonly began: readonly Ticket[] } | { readonly ok: false; readonly reason: string };

export interface ChainArranger {
  arrange(chains: readonly ChainSpec[]): ArrangeOutcome;
  deployed(ticket: number): TicketOutcome;
  proceed(ticket: number): TicketOutcome;
}

export interface OwnerStart {
  readonly assertion: string | undefined;
  readonly chains: readonly ChainStartItem[];
}

export type StartError = "forbidden" | "conflict";

export type StartOutcome = { readonly ok: true; readonly tickets: readonly Ticket[] } | { readonly ok: false; readonly error: StartError };

export interface ChainStarter {
  start(given: OwnerStart): Promise<StartOutcome>;
}

export type Tell = (conversation: string | null, notice: string, prompt: string) => void;

export interface Chains {
  readonly arranger: ChainArranger;
  readonly starter: ChainStarter;
  cards(): StartCard[];
  resume(): void;
  idle(): Promise<void>;
  close(): void;
}

export interface ChainsOptions {
  readonly database: HubDatabase;
  readonly clock: Clock;
  readonly tickets: TicketService;
  readonly verify: AccessVerifier;
  readonly ownerEmail: string;
  readonly work?: TicketWork;
  readonly tell?: Tell;
}

const everyTicket = 100_000;

export function chainFingerprint(tickets: readonly Ticket[]): string {
  const shape = tickets.map((ticket) => [
    ticket.id,
    ticket.state,
    ticket.repository,
    ticket.kind,
    ticket.difficulty,
    ticket.platform,
    ticket.title.en,
    ticket.title.zh,
    ticket.issues.map((issue) => [issue.repository, issue.number, issue.title.en, issue.title.zh]),
    ticket.waits.map((wait) => [wait.ticket, wait.deployment, wait.waived]),
  ]);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function issueKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

function highest(values: readonly (Difficulty | null)[]): Difficulty | null {
  let best: Difficulty | null = null;
  for (const value of values) {
    if (value !== null && (best === null || difficulties.indexOf(value) > difficulties.indexOf(best))) {
      best = value;
    }
  }
  return best;
}

const BeginRow = z.object({ ticket_id: z.number().int() });

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function described(ticket: Ticket): string {
  return `ticket ${ticket.id} (${ticket.title.en})`;
}

export function createChains(options: ChainsOptions): Chains {
  const { tickets, clock } = options;
  const { connection } = options.database;
  const owner = options.ownerEmail.toLowerCase();
  const tell: Tell = options.tell ?? (() => undefined);
  const work = options.work;
  const running = new Set<Promise<void>>();
  const toldStopped = new Set<number>();
  let advancing = false;
  let again = false;
  let closed = false;

  const insertBegin = connection.prepare(
    "INSERT INTO ticket_begins (ticket_id, due_at) VALUES (?, ?) ON CONFLICT (ticket_id) DO UPDATE SET due_at = excluded.due_at, done_at = NULL, failed_at = NULL, failure = NULL",
  );
  const markBegun = connection.prepare("UPDATE ticket_begins SET done_at = ? WHERE ticket_id = ? AND done_at IS NULL AND failed_at IS NULL");
  const markFailed = connection.prepare("UPDATE ticket_begins SET failed_at = ?, failure = ? WHERE ticket_id = ? AND done_at IS NULL AND failed_at IS NULL");
  const selectDue = connection.prepare(
    "SELECT b.ticket_id FROM ticket_begins b JOIN tickets t ON t.id = b.ticket_id WHERE b.done_at IS NULL AND b.failed_at IS NULL AND t.state = 'working' ORDER BY b.ticket_id",
  );

  const openTickets = (): Ticket[] => tickets.list({ open: true, limit: everyTicket });

  const withBefore = (list: readonly Ticket[]): Map<number, Ticket> => {
    const index = indexOf(list);
    for (const ticket of list) {
      for (const wait of ticket.waits) {
        if (!index.has(wait.ticket)) {
          const before = tickets.get(wait.ticket);
          if (before !== undefined) {
            index.set(before.id, before);
          }
        }
      }
    }
    return index;
  };

  const fingerprintOf = (root: number, list: readonly Ticket[]): string | undefined => {
    const index = indexOf(list);
    const closure = arrangedAfter([root], list);
    if (closure.length === 0) {
      return undefined;
    }
    return chainFingerprint(closure.flatMap((id) => {
      const ticket = index.get(id);
      return ticket === undefined ? [] : [ticket];
    }));
  };

  const begin = (ids: readonly number[]) => {
    for (const id of ids) {
      const ticket = tickets.get(id);
      if (ticket === undefined || ticket.state !== "working") {
        continue;
      }
      const task = (async () => {
        try {
          await work?.begin(ticket);
          markBegun.run(clock.now(), id);
        } catch (error) {
          const reason = reasonOf(error);
          markFailed.run(clock.now(), reason, id);
          if (!closed) {
            tickets.change((writes) => writes.touched(id));
            tell(
              ticket.conversation,
              text("notice.ticketBeginFailed", { ticket: id }),
              [
                `[hub] The owner started ${described(ticket)}, but its work could not begin: ${reason}`,
                "It stays recorded as working, with that failure. Decide what happens to it: stop it with stop_ticket and arrange the work again, or find and fix the cause. Tell the owner what you decided.",
              ].join("\n"),
            );
          }
        }
      })();
      const tracked = task.finally(() => running.delete(tracked));
      running.add(tracked);
    }
  };

  const advance = () => {
    if (closed) {
      return;
    }
    if (advancing) {
      again = true;
      return;
    }
    advancing = true;
    try {
      do {
        again = false;
        const list = openTickets();
        const index = withBefore(list);
        const ready = list.filter((ticket) => ticket.state === "waiting" && readyToBegin(ticket, index)).map((ticket) => ticket.id);
        if (ready.length === 0) {
          continue;
        }
        const began = tickets.change((writes) =>
          ready.filter((id) => {
            if (writes.get(id)?.state !== "waiting") {
              return false;
            }
            writes.move(id, "working");
            insertBegin.run(id, clock.now());
            return true;
          }),
        );
        begin(began);
      } while (again);
    } finally {
      advancing = false;
    }
  };

  const tellStopped = (stopped: Ticket) => {
    if (toldStopped.has(stopped.id)) {
      return;
    }
    toldStopped.add(stopped.id);
    const why = stopped.stopReason === null ? "" : `: ${stopped.stopReason.en}`;
    for (const after of tickets.waitingFor(stopped.id)) {
      if ((after.state !== "waiting" && after.state !== "pending") || !after.waits.some((wait) => wait.ticket === stopped.id && !wait.waived)) {
        continue;
      }
      const choice =
        after.state === "waiting"
          ? `The owner already started it, and it waits for ${described(stopped)}. Decide what happens to it: let it go ahead without ticket ${stopped.id} with proceed_ticket, or stop it with stop_ticket.`
          : `It is not started yet and is arranged after ticket ${stopped.id}. Arrange it again with arrange_chains, or stop it with stop_ticket.`;
      tell(
        after.conversation ?? stopped.conversation,
        text("notice.ticketBeforeStopped", { before: stopped.id, ticket: after.id }),
        [`[hub] ${described(stopped)} stopped${why}.`, `${described(after)} is ${after.state}. ${choice}`, "Tell the owner what you decided."].join("\n"),
      );
    }
  };

  const unsubscribe = tickets.subscribe((ticket) => {
    if (ticket.state === "stopped") {
      tellStopped(ticket);
      return;
    }
    if (ticket.state === "merged" || ticket.state === "waiting") {
      advance();
    }
  });

  const isOwner = async (assertion: string | undefined): Promise<boolean> => {
    try {
      const result = await options.verify(assertion);
      return result.ok && result.identity.kind === "person" && result.identity.email === owner;
    } catch {
      return false;
    }
  };

  const start = async (given: OwnerStart): Promise<StartOutcome> => {
    if (!(await isOwner(given.assertion))) {
      return { ok: false, error: "forbidden" };
    }
    if (closed || given.chains.length === 0) {
      return { ok: false, error: "conflict" };
    }
    const list = openTickets();
    const index = indexOf(list);
    const chosen = new Set<number>();
    for (const item of given.chains) {
      const root = index.get(item.ticket);
      if (root === undefined || root.state !== "pending") {
        return { ok: false, error: "conflict" };
      }
      if (fingerprintOf(item.ticket, list) !== item.fingerprint) {
        return { ok: false, error: "conflict" };
      }
      for (const id of arrangedAfter([item.ticket], list)) {
        chosen.add(id);
      }
    }
    if (startGaps([...chosen], index).length > 0) {
      return { ok: false, error: "conflict" };
    }
    const order = inWorkingOrder([...chosen], index);
    let began: number[];
    try {
      began = tickets.change((writes) => {
        const now: number[] = [];
        for (const id of order) {
          const ticket = writes.get(id);
          if (ticket?.state !== "pending") {
            throw new TicketError(`Ticket ${id} is no longer pending`);
          }
          const lookup = new Map<number, ChainNode>();
          for (const wait of ticket.waits) {
            const before = writes.get(wait.ticket);
            if (before !== undefined) {
              lookup.set(before.id, before);
            }
          }
          if (readyToBegin(ticket, lookup)) {
            writes.move(id, "working");
            insertBegin.run(id, clock.now());
            now.push(id);
          } else {
            writes.move(id, "waiting");
          }
        }
        return now;
      });
    } catch (error) {
      if (error instanceof TicketError) {
        return { ok: false, error: "conflict" };
      }
      throw error;
    }
    begin(began);
    return {
      ok: true,
      tickets: order.flatMap((id) => {
        const ticket = tickets.get(id);
        return ticket === undefined ? [] : [ticket];
      }),
    };
  };

  const arrange = (specs: readonly ChainSpec[]): ArrangeOutcome => {
    const refuse = (reason: string): ArrangeOutcome => ({ ok: false, reason: `Nothing was changed: ${reason}` });
    if (specs.length === 0) {
      return refuse("the arrangement names no chain");
    }
    const names = new Set<string>();
    for (const spec of specs) {
      if (spec.name.trim() === "") {
        return refuse("every chain needs a name");
      }
      if (names.has(spec.name)) {
        return refuse(`the chain name ${spec.name} is used twice`);
      }
      names.add(spec.name);
      if (!RepositoryName.safeParse(spec.repository).success) {
        return refuse(`${spec.repository} in chain ${spec.name} is not a repository as owner/name`);
      }
      if (spec.issues.length === 0) {
        return refuse(`chain ${spec.name} has no issues`);
      }
    }
    const list = openTickets();
    const holder = new Map<string, Ticket>();
    for (const ticket of list) {
      if (ticket.state !== "pending") {
        continue;
      }
      for (const issue of ticket.issues) {
        holder.set(issueKey(issue.repository, issue.number), ticket);
      }
    }
    const named = new Map<string, string>();
    const sources = new Map<number, Ticket>();
    const issuesOf = new Map<string, TicketIssue[]>();
    for (const spec of specs) {
      const issues: TicketIssue[] = [];
      for (const number of spec.issues) {
        const key = issueKey(spec.repository, number);
        const already = named.get(key);
        if (already !== undefined) {
          return refuse(`issue ${spec.repository}#${number} is named in chain ${already} and in chain ${spec.name}; an issue belongs to one chain`);
        }
        named.set(key, spec.name);
        const ticket = holder.get(key);
        if (ticket === undefined) {
          const started = tickets.forIssue(spec.repository, number).find((found) => found.state !== "stopped");
          if (started !== undefined) {
            return refuse(
              `issue ${spec.repository}#${number} is on ticket ${started.id}, which is ${started.state}. A started chain is closed: file the later work as a new issue and arrange it after ticket ${started.id}`,
            );
          }
          return refuse(`no pending ticket holds issue ${spec.repository}#${number}; it does not exist here. File it with file_issue, or open a ticket for it with open_ticket, first`);
        }
        const issue = ticket.issues.find((entry) => entry.number === number && entry.repository.toLowerCase() === spec.repository.toLowerCase());
        if (issue === undefined) {
          return refuse(`issue ${spec.repository}#${number} could not be read from ticket ${ticket.id}`);
        }
        issues.push(issue);
        sources.set(ticket.id, ticket);
      }
      issuesOf.set(spec.name, issues);
    }
    for (const source of sources.values()) {
      const left = source.issues.filter((issue) => !named.has(issueKey(issue.repository, issue.number)));
      if (left.length > 0) {
        return refuse(
          `ticket ${source.id} also holds ${left.map((issue) => `${issue.repository}#${issue.number}`).join(", ")}; name every issue of a ticket you arrange`,
        );
      }
    }
    const byId = indexOf(list);
    for (const spec of specs) {
      for (const before of spec.after ?? []) {
        if (typeof before === "string") {
          if (before === spec.name) {
            return refuse(`chain ${spec.name} cannot come after itself`);
          }
          if (!names.has(before)) {
            return refuse(`chain ${spec.name} comes after ${before}, which is not a chain of this arrangement`);
          }
          continue;
        }
        const ticket = byId.get(before) ?? tickets.get(before);
        if (ticket === undefined) {
          return refuse(`chain ${spec.name} comes after ticket ${before}, which does not exist`);
        }
        if (sources.has(before)) {
          return refuse(`chain ${spec.name} comes after ticket ${before}, which this arrangement rearranges; name its chain instead`);
        }
        if (ticket.state === "stopped") {
          return refuse(`chain ${spec.name} comes after ticket ${before}, which has stopped`);
        }
      }
    }
    const plans = new Map<string, { title: GeneratedText; summary: GeneratedText; kind: TicketKind; difficulty: Difficulty | null; platform: Platform | null; conversation: string | null }>();
    for (const spec of specs) {
      const issues = issuesOf.get(spec.name) ?? [];
      const from = [...new Set(issues.map((issue) => holder.get(issueKey(issue.repository, issue.number))))].flatMap((ticket) => (ticket === undefined ? [] : [ticket]));
      const whole = from.length === 1 && from[0] !== undefined && from[0].issues.length === issues.length ? from[0] : undefined;
      const first = issues[0];
      const title = spec.title ?? whole?.title ?? (issues.length === 1 && first !== undefined ? first.title : undefined);
      const summary = spec.summary ?? whole?.summary ?? (issues.length === 1 && first !== undefined ? first.summary : undefined);
      if (title === undefined || summary === undefined) {
        return refuse(`chain ${spec.name} has several issues and needs its own title and summary, each in English and Chinese`);
      }
      if (!GeneratedText.safeParse(title).success || !GeneratedText.safeParse(summary).success) {
        return refuse(`the title and summary of chain ${spec.name} each need an English original and a Chinese copy`);
      }
      const platforms = [...new Set(from.map((ticket) => ticket.platform).filter((platform) => platform !== null && platform !== "any"))];
      if (spec.platform === undefined && platforms.length > 1) {
        return refuse(`chain ${spec.name} needs ${platforms.join(" and ")}; cut it where the platform changes`);
      }
      const head = from[0];
      if (head === undefined) {
        return refuse(`chain ${spec.name} has no issues`);
      }
      plans.set(spec.name, {
        title,
        summary,
        kind: spec.kind ?? head.kind,
        difficulty: spec.difficulty ?? highest(from.map((ticket) => ticket.difficulty)),
        platform: spec.platform ?? platforms[0] ?? (from.some((ticket) => ticket.platform === "any") ? "any" : null),
        conversation: head.conversation,
      });
    }
    const claimed = new Map<string, number>();
    const taken = new Set<number>();
    for (const spec of specs) {
      const wanted = new Set((issuesOf.get(spec.name) ?? []).map((issue) => issueKey(issue.repository, issue.number)));
      const same = [...sources.values()].find(
        (ticket) => !taken.has(ticket.id) && ticket.issues.length === wanted.size && ticket.issues.every((issue) => wanted.has(issueKey(issue.repository, issue.number))),
      );
      if (same !== undefined) {
        claimed.set(spec.name, same.id);
        taken.add(same.id);
      }
    }
    for (const spec of specs) {
      if (claimed.has(spec.name)) {
        continue;
      }
      const candidates = [...new Set((issuesOf.get(spec.name) ?? []).map((issue) => holder.get(issueKey(issue.repository, issue.number))?.id))]
        .flatMap((id) => (id === undefined || taken.has(id) ? [] : [id]))
        .sort((a, b) => a - b);
      const pick = candidates[0];
      if (pick !== undefined) {
        claimed.set(spec.name, pick);
        taken.add(pick);
      }
    }
    let placeholder = -1;
    const idOf = new Map<string, number>();
    for (const spec of specs) {
      idOf.set(spec.name, claimed.get(spec.name) ?? placeholder--);
    }
    const chainOfIssue = new Map<string, string>(named);
    const targets = (source: Ticket): number[] =>
      [...new Set(source.issues.map((issue) => chainOfIssue.get(issueKey(issue.repository, issue.number))))].flatMap((name) => {
        const id = name === undefined ? undefined : idOf.get(name);
        return id === undefined ? [] : [id];
      });
    const chainWaits = new Map<string, WaitToSet[]>();
    for (const spec of specs) {
      chainWaits.set(
        spec.name,
        (spec.after ?? []).map((before) => ({ ticket: typeof before === "string" ? (idOf.get(before) ?? 0) : before, deployment: spec.afterDeployment === true })),
      );
    }
    const chainIds = new Set(idOf.values());
    const outsideWaits = new Map<number, WaitToSet[]>();
    for (const ticket of list) {
      if (ticket.state !== "pending" || chainIds.has(ticket.id) || sources.has(ticket.id)) {
        continue;
      }
      if (!ticket.waits.some((wait) => sources.has(wait.ticket))) {
        continue;
      }
      const waits: WaitToSet[] = [];
      for (const wait of ticket.waits) {
        const source = sources.get(wait.ticket);
        if (source === undefined) {
          waits.push({ ticket: wait.ticket, deployment: wait.deployment });
        } else {
          for (const target of targets(source)) {
            waits.push({ ticket: target, deployment: wait.deployment });
          }
        }
      }
      outsideWaits.set(ticket.id, waits);
    }
    const graph: ChainNode[] = [];
    for (const ticket of list) {
      if (sources.has(ticket.id)) {
        continue;
      }
      const rewired = outsideWaits.get(ticket.id);
      const waits = rewired === undefined ? ticket.waits : rewired.map((wait) => ({ ...wait, waived: false }));
      graph.push({ id: ticket.id, state: ticket.state, deployedAt: ticket.deployedAt, waits });
    }
    for (const spec of specs) {
      graph.push({
        id: idOf.get(spec.name) ?? 0,
        state: "pending",
        deployedAt: null,
        waits: (chainWaits.get(spec.name) ?? []).map((wait) => ({ ...wait, waived: false })),
      });
    }
    const cycle = findCycle(waitEdges(graph));
    if (cycle !== undefined) {
      const nameOf = (id: number) => specs.find((spec) => idOf.get(spec.name) === id)?.name;
      return refuse(`it has a cycle: ${cycle.map((id) => (nameOf(id) === undefined ? `ticket ${id}` : `chain ${nameOf(id) ?? ""}`)).join(" waits for ")}`);
    }
    let written: { chains: Map<string, number>; joined: number[] };
    try {
      written = tickets.change((writes) => {
        const real = new Map<string, number>();
        for (const spec of specs) {
          const plan = plans.get(spec.name);
          const issues = issuesOf.get(spec.name) ?? [];
          if (plan === undefined) {
            continue;
          }
          const existing = claimed.get(spec.name);
          const id =
            existing ??
            writes.open({
              repository: issues[0]?.repository ?? spec.repository,
              issues,
              title: plan.title,
              summary: plan.summary,
              kind: plan.kind,
              difficulty: plan.difficulty ?? undefined,
              platform: plan.platform ?? undefined,
              conversation: plan.conversation ?? undefined,
            });
          if (existing !== undefined) {
            writes.setIssues(id, issues);
          }
          writes.describe(id, plan);
          real.set(spec.name, id);
        }
        const actual = (id: number): number => {
          const name = specs.find((spec) => idOf.get(spec.name) === id)?.name;
          return name === undefined ? id : (real.get(name) ?? id);
        };
        for (const spec of specs) {
          const id = real.get(spec.name);
          if (id !== undefined) {
            writes.setWaits(id, (chainWaits.get(spec.name) ?? []).map((wait) => ({ ticket: actual(wait.ticket), deployment: wait.deployment })));
          }
        }
        for (const [id, waits] of outsideWaits) {
          writes.setWaits(id, waits.map((wait) => ({ ticket: actual(wait.ticket), deployment: wait.deployment })));
        }
        const joined: number[] = [];
        for (const source of sources.values()) {
          if (taken.has(source.id)) {
            continue;
          }
          const into = targets(source).map(actual)[0] ?? 0;
          writes.move(source.id, "stopped", { en: `Joined ticket ${into} by an arrangement`, zh: text("ticket.reason.joined", { ticket: into }) });
          joined.push(source.id);
        }
        return { chains: real, joined };
      });
    } catch (error) {
      if (error instanceof TicketError) {
        return refuse(error.message);
      }
      throw error;
    }
    return {
      ok: true,
      chains: specs.flatMap((spec) => {
        const id = written.chains.get(spec.name);
        const ticket = id === undefined ? undefined : tickets.get(id);
        return ticket === undefined ? [] : [{ name: spec.name, ticket }];
      }),
      joined: written.joined,
    };
  };

  const deployed = (id: number): TicketOutcome => {
    const ticket = tickets.get(id);
    if (ticket === undefined) {
      return { ok: false, reason: `There is no ticket ${id}.` };
    }
    if (ticket.state !== "merged") {
      return { ok: false, reason: `Ticket ${id} is ${ticket.state}; only merged work is deployed.` };
    }
    const before = new Set(openTickets().filter((entry) => entry.state === "working").map((entry) => entry.id));
    tickets.change((writes) => writes.deployed(id));
    advance();
    return { ok: true, ticket: tickets.get(id) ?? ticket, began: openTickets().filter((entry) => entry.state === "working" && !before.has(entry.id)) };
  };

  const proceed = (id: number): TicketOutcome => {
    const ticket = tickets.get(id);
    if (ticket === undefined) {
      return { ok: false, reason: `There is no ticket ${id}.` };
    }
    if (ticket.state !== "waiting") {
      return {
        ok: false,
        reason:
          ticket.state === "pending"
            ? `Ticket ${id} is not started; only the owner starts it, with 开始 on its card. Arrange it again with arrange_chains if what it waits for has changed.`
            : `Ticket ${id} is ${ticket.state} and is not waiting.`,
      };
    }
    const stopped = ticket.waits.filter((wait) => !wait.waived && tickets.get(wait.ticket)?.state === "stopped").map((wait) => wait.ticket);
    if (stopped.length === 0) {
      return { ok: false, reason: `Nothing ticket ${id} waits for has stopped; it begins by itself when what it waits for has merged.` };
    }
    tickets.change((writes) => {
      for (const before of stopped) {
        writes.waive(id, before);
      }
    });
    advance();
    const now = tickets.get(id) ?? ticket;
    return { ok: true, ticket: now, began: now.state === "working" ? [now] : [] };
  };

  const cards = (): StartCard[] => {
    const list = openTickets();
    const index = withBefore(list);
    const listIndex = indexOf(list);
    return list
      .filter((ticket) => ticket.state === "pending")
      .flatMap((ticket): StartCard[] => {
        const fingerprint = fingerprintOf(ticket.id, list);
        if (fingerprint === undefined) {
          return [];
        }
        return [
          {
            kind: "start",
            key: cardKey("start", String(ticket.id)),
            at: ticket.createdAt,
            ticket,
            fingerprint,
            before: unmetWaits(ticket, index).flatMap((wait) => {
              const before = index.get(wait.ticket);
              return before === undefined ? [] : [{ id: before.id, title: before.title, repository: before.repository, state: before.state }];
            }),
            startable: canStartAlone(ticket, listIndex),
          },
        ];
      });
  };

  return {
    arranger: { arrange, deployed, proceed },
    starter: { start },
    cards,
    resume: () => {
      begin(selectDue.all().map((row) => BeginRow.parse(row).ticket_id));
      advance();
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
