import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brainToolsPath, conversationHeader, protocolVersion, type RunningTurn, turnHeader } from "@super-agent2/protocol";
import type { BrainLink } from "../conversations.js";
import type { Hub } from "../hub.js";

export function attachBrain(hub: Hub, running: RunningTurn[] = []): BrainLink {
  const brain = hub.conversations.attach({ send: () => undefined, close: () => undefined });
  brain.receive({ type: "hello", protocol: protocolVersion, running });
  return brain;
}

export function startToolTurn(brain: BrainLink, conversation: string): RunningTurn {
  const turn = randomUUID();
  brain.receive({ type: "turn.started", conversation, turn, provider: "gpt", model: "test", inputs: [] });
  return { conversation, turn };
}

export async function requestBrainTool(hub: Hub, name: string, args: Record<string, unknown>, scope?: RunningTurn) {
  const token = readFileSync(join(hub.database.dataDir, "brain.token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${hub.address.port}${brainToolsPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(scope === undefined ? {} : { [conversationHeader]: scope.conversation, [turnHeader]: scope.turn }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const reply = (await response.json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { message: string } };
  return reply.result === undefined ? { isError: true, text: reply.error?.message ?? "" } : { isError: reply.result.isError, text: reply.result.content.map((part) => part.text).join("") };
}

const testBrains = new WeakMap<Hub, { link: BrainLink; topic: string }>();

export async function callBrainTool(hub: Hub, name: string, args: Record<string, unknown>, conversation?: string) {
  let brain = testBrains.get(hub);
  if (brain === undefined) {
    brain = { link: attachBrain(hub), topic: conversation ?? hub.conversations.create().id };
    testBrains.set(hub, brain);
  }
  const scope = startToolTurn(brain.link, conversation ?? brain.topic);
  const affected = name === "arrange_chains" || name === "open_repair_ticket" || name === "choose_defaults"
    ? hub.tickets.list({ limit: 1000 }).map((ticket) => ticket.id)
    : typeof args["ticket"] === "number" && name !== "read_ticket" ? [args["ticket"]] : [];
  try {
    for (const ticket of affected) {
      await requestBrainTool(hub, "read_ticket", { ticket }, scope);
    }
    return await requestBrainTool(hub, name, args, scope);
  } finally {
    brain.link.receive({ type: "turn.finished", ...scope, outcome: "completed", reason: null });
  }
}
