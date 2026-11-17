import { describe, expect, it } from "vitest";
import { ServerMessage } from "./hub.js";
import {
  canMoveTicket,
  finishedTicketStates,
  isOpenTicket,
  openTicketStates,
  RepositoryName,
  Ticket,
  ticketKinds,
  ticketMoves,
  ticketStates,
} from "./tickets.js";

const ticket = {
  id: 1,
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
  round: 0,
  waitsFor: [],
  waits: [],
  deployedAt: null,
  beginFailure: null,
  stopReason: null,
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
    expect(openTicketStates).toEqual(["pending", "waiting", "working", "verifying"]);
    expect(finishedTicketStates).toEqual(["merged", "delivered", "stopped"]);
    expect(isOpenTicket("pending")).toBe(true);
    expect(isOpenTicket("stopped")).toBe(false);
  });

  it("lets every open ticket stop, and nothing move out of a finished state", () => {
    for (const kind of ticketKinds) {
      for (const state of openTicketStates) {
        expect(canMoveTicket(kind, state, "stopped")).toBe(true);
      }
      for (const state of finishedTicketStates) {
        for (const next of ticketStates) {
          expect(canMoveTicket(kind, state, next)).toBe(false);
        }
      }
    }
  });

  it("follows the flow from pending through work to its end", () => {
    expect(canMoveTicket("fix", "pending", "working")).toBe(true);
    expect(canMoveTicket("fix", "pending", "waiting")).toBe(true);
    expect(canMoveTicket("fix", "waiting", "working")).toBe(true);
    expect(canMoveTicket("fix", "working", "verifying")).toBe(true);
    expect(canMoveTicket("fix", "verifying", "working")).toBe(true);
    expect(canMoveTicket("fix", "verifying", "merged")).toBe(true);
    expect(canMoveTicket("writing", "working", "delivered")).toBe(true);
  });

  it("refuses moves the table does not list", () => {
    expect(canMoveTicket("fix", "pending", "merged")).toBe(false);
    expect(canMoveTicket("fix", "pending", "verifying")).toBe(false);
    expect(canMoveTicket("fix", "working", "pending")).toBe(false);
    expect(canMoveTicket("fix", "pending", "pending")).toBe(false);
  });

  it("keeps a writing ticket out of verification and merging, and code out of delivery", () => {
    expect(canMoveTicket("writing", "working", "verifying")).toBe(false);
    expect(canMoveTicket("writing", "verifying", "merged")).toBe(false);
    expect(canMoveTicket("feature", "working", "delivered")).toBe(false);
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

  it("allows a writing ticket with no repository", () => {
    expect(Ticket.safeParse({ ...ticket, kind: "writing", repository: null, issues: [] }).success).toBe(true);
  });

  it("knows a repository name from other text", () => {
    expect(RepositoryName.safeParse("novan-xu/super-agent2").success).toBe(true);
    expect(RepositoryName.safeParse("novan-xu/a.b_c").success).toBe(true);
    for (const bad of ["novan-xu", "novan-xu/", "/x", "a/b/c", "a b/c", "a/b c", "a/..", "a/.", "a/b&c", 'a/b"c', "a/b%c"]) {
      expect(RepositoryName.safeParse(bad).success).toBe(false);
    }
  });
});
