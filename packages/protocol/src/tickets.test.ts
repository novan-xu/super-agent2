import { describe, expect, it } from "vitest";
import { readDeploymentFile } from "./deployments.js";
import { ServerMessage } from "./hub.js";
import { TaskHandback } from "./work.js";
import {
  canMoveTicket,
  codeKinds,
  finishedTicketStates,
  hasRemainingWork,
  fitsForm,
  isOpenTicket,
  openTicketStates,
  RepositoryName,
  taskKinds,
  Ticket,
  ticketForms,
  ticketKinds,
  ticketMoves,
  ticketStates,
} from "./tickets.js";

const ticket = {
  id: 1,
  code: "aa",
  codeDate: "2026-11-19",
  form: "code",
  repository: "novan-xu/super-agent-sandbox",
  issues: [
    {
      repository: "novan-xu/super-agent-sandbox",
      number: 7,
      url: "https://github.com/novan-xu/super-agent-sandbox/issues/7",
      title: { en: "Add a greeting", zh: "加一句问候" },
      summary: { en: "Print hello", zh: "打印问候" },
    },
  ],
  title: { en: "Add a greeting", zh: "加一句问候" },
  summary: { en: "Print hello", zh: "打印问候" },
  kind: "feature",
  difficulty: null,
  difficultyReason: null,
  platform: null,
  requiredMachine: null,
  commitRef: null,
  commit: null,
  deploys: false,
  brainEngine: null,
  ownerChoice: { machine: null, engine: null, model: null, effort: null },
  state: "pending",
  machine: null,
  engine: null,
  model: null,
  effort: null,
  chosenBy: null,
  chosenAt: null,
  ran: null,
  branch: null,
  pullRequest: null,
  pullRequests: [],
  decisions: [],
  round: 0,
  freeRetry: false,
  stuck: null,
  waitsFor: [],
  waits: [],
  deployedAt: null,
  beginFailure: null,
  report: null,
  work: null,
  verification: null,
  stopReason: null,
  joinedInto: null,
  repairs: null,
  repairedBy: null,
  endedAt: null,
  conversation: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("ticket states", () => {
  it("lists a move from every state, and only to states that exist", () => {
    for (const state of ticketStates) {
      for (const next of ticketMoves[state]) {
        expect(ticketStates).toContain(next);
      }
    }
  });

  it("splits the states into open and finished", () => {
    expect(openTicketStates).toEqual(["pending", "waiting", "working", "verifying", "stuck"]);
    expect(finishedTicketStates).toEqual(["merged", "delivered", "stopped"]);
    expect(isOpenTicket("pending")).toBe(true);
    expect(isOpenTicket("stopped")).toBe(false);
  });

  it("lets every open ticket stop, and nothing move out of a finished state", () => {
    for (const form of ticketForms) {
      for (const state of openTicketStates) {
        expect(canMoveTicket(form, state, "stopped")).toBe(true);
      }
      for (const state of finishedTicketStates) {
        for (const next of ticketStates) {
          expect(canMoveTicket(form, state, next)).toBe(false);
        }
      }
    }
  });

  it("follows the flow from pending through work to its end", () => {
    expect(canMoveTicket("code", "pending", "working")).toBe(true);
    expect(canMoveTicket("code", "pending", "waiting")).toBe(true);
    expect(canMoveTicket("code", "waiting", "working")).toBe(true);
    expect(canMoveTicket("code", "working", "verifying")).toBe(true);
    expect(canMoveTicket("code", "verifying", "working")).toBe(true);
    expect(canMoveTicket("code", "verifying", "merged")).toBe(true);
    expect(canMoveTicket("task", "working", "delivered")).toBe(true);
  });

  it("refuses moves the table does not list", () => {
    expect(canMoveTicket("code", "pending", "merged")).toBe(false);
    expect(canMoveTicket("code", "pending", "verifying")).toBe(false);
    expect(canMoveTicket("code", "working", "pending")).toBe(false);
    expect(canMoveTicket("code", "pending", "pending")).toBe(false);
  });

  it("keeps a task ticket out of verification and merging, and code out of delivery", () => {
    expect(canMoveTicket("task", "working", "verifying")).toBe(false);
    expect(canMoveTicket("task", "verifying", "merged")).toBe(false);
    expect(canMoveTicket("code", "working", "delivered")).toBe(false);
  });
});

describe("ticket messages", () => {
  it("accepts a ticket and carries it to the page", () => {
    expect(Ticket.parse(ticket)).toEqual(ticket);
    expect(ServerMessage.parse({ type: "ticket", ticket }).type).toBe("ticket");
    expect(ServerMessage.parse({ type: "tickets", tickets: [ticket] }).type).toBe("tickets");
  });

  it("refuses a title without its Chinese copy", () => {
    expect(Ticket.safeParse({ ...ticket, title: { en: "Add a greeting", zh: "Add a greeting" } }).success).toBe(false);
  });

  it("allows a task ticket with no repository, and one that deploys a repository at a commit", () => {
    expect(Ticket.safeParse({ ...ticket, form: "task", kind: "writing", repository: null, issues: [] }).success).toBe(true);
    expect(Ticket.safeParse({ ...ticket, form: "task", kind: "operation", issues: [], requiredMachine: "pc", commitRef: "merged", commit: "a".repeat(40), deploys: true }).success).toBe(true);
  });

  it("reads a ticket from a hub that did not know forms as code", () => {
    const { form: _form, requiredMachine: _machine, commitRef: _ref, commit: _commit, deploys: _deploys, ...older } = ticket;
    expect(Ticket.parse(older)).toMatchObject({ form: "code", requiredMachine: null, commitRef: null, commit: null, deploys: false });
  });

  it("reads a ticket from a hub that did not know repair tickets as one with no repair on either side", () => {
    const { repairs: _repairs, repairedBy: _repairedBy, ...older } = ticket;
    expect(Ticket.parse(older)).toMatchObject({ repairs: null, repairedBy: null });
    expect(Ticket.parse({ ...ticket, repairs: 4, repairedBy: 9 })).toMatchObject({ repairs: 4, repairedBy: 9 });
  });

  it("knows what remains of a ticket that stopped", () => {
    const issues = [{ number: 7 }, { number: 8 }];
    expect(hasRemainingWork({ form: "code", issues, pullRequests: [{ state: "merged", closes: [7] }] })).toBe(true);
    expect(hasRemainingWork({ form: "code", issues, pullRequests: [{ state: "merged", closes: [7, 8] }] })).toBe(false);
    expect(hasRemainingWork({ form: "code", issues, pullRequests: [{ state: "open", closes: [7, 8] }] })).toBe(true);
    expect(hasRemainingWork({ form: "task", issues: [], pullRequests: [] })).toBe(true);
  });

  it("knows a repository name from other text", () => {
    expect(RepositoryName.safeParse("novan-xu/super-agent2").success).toBe(true);
    expect(RepositoryName.safeParse("novan-xu/a.b_c").success).toBe(true);
    for (const bad of ["novan-xu", "novan-xu/", "/x", "a/b/c", "a b/c", "a/b c", "a/..", "a/.", "a/b&c", 'a/b"c', "a/b%c"]) {
      expect(RepositoryName.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the kinds of each form of ticket", () => {
  it("gives a task ticket prose or an operation, and a code ticket the kinds of repository work", () => {
    expect(taskKinds).toEqual(["writing", "operation"]);
    expect([...taskKinds, ...codeKinds].sort()).toEqual([...ticketKinds].sort());
    expect(fitsForm("task", "operation")).toBe(true);
    expect(fitsForm("task", "fix")).toBe(false);
    expect(fitsForm("code", "writing")).toBe(false);
    expect(fitsForm("code", "maintenance")).toBe(true);
  });
});

describe("a task worker's hand-back", () => {
  it("is done unless it says it failed, and still reads a writer's summary as its report", () => {
    expect(TaskHandback.parse({ report: { en: "Done", zh: "完成了" } })).toMatchObject({ outcome: "done", files: [] });
    expect(TaskHandback.parse({ outcome: "failed", report: { en: "The service did not come up", zh: "服务没有起来" } }).outcome).toBe("failed");
    expect(TaskHandback.parse({ text: "result.md", summary: { en: "Translated", zh: "翻译好了" } }).report).toEqual({ en: "Translated", zh: "翻译好了" });
    expect(TaskHandback.safeParse({ outcome: "maybe", report: { en: "x", zh: "好" } }).success).toBe(false);
  });
});

describe("a deployment file", () => {
  const file = { target: "pc", deploy: "./deploy.sh", health: { command: "curl -fsS http://127.0.0.1:8080/health" }, rollback: "./rollback.sh" };

  it("names the work machine its worker runs on", () => {
    expect(readDeploymentFile(JSON.stringify(file))).toMatchObject({ ok: true, file: { target: "pc", health: { everySeconds: 5, withinSeconds: 120 } } });
  });

  it("is refused when it names the hub's container or the NAS host, or a key it does not know", () => {
    for (const target of ["hub", "nas"]) {
      const reading = readDeploymentFile(JSON.stringify({ ...file, target }));
      expect(reading.ok).toBe(false);
      expect(reading.ok ? "" : reading.reason).toContain("names no work machine");
    }
    expect(readDeploymentFile(JSON.stringify({ ...file, token: "x" })).ok).toBe(false);
    expect(readDeploymentFile("{").ok).toBe(false);
  });
});
