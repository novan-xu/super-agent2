import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPushDevice, type Hub, type PushDevice, receivePush, type Target } from "@super-agent2/hub";
import { TicketState } from "@super-agent2/protocol";

export const demoTargetName = "demo";

export function demoTarget(): Target {
  return {
    name: demoTargetName,
    run: (job, sink) => {
      sink("stdout", Buffer.from(`pretend run, nothing executed: ${job.command}\n`));
      return { ended: Promise.resolve({ exitCode: 0, signal: null }), stop: () => Promise.resolve() };
    },
  };
}

const heldCommands: Readonly<Record<string, string>> = {
  repo: "gh repo delete novan-xu/old-experiments --yes",
  branch: "git push --force origin main",
  data: "docker volume rm super-agent-data",
  file: "rm -rf /srv/other/notes",
  long: [
    "set -euo pipefail",
    "cd /srv/projects/app",
    "for repo in alpha beta gamma; do",
    '  echo "checking $repo"',
    "  git -C \"$repo\" fetch --all --prune",
    "done",
    "gh repo delete novan-xu/old-experiments --yes && echo done-with-a-very-long-line-that-keeps-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going-and-going",
  ].join("\n"),
  hidden: "gh repo delete novan-xu/old-experiments --yes # ​‮ done",
};

interface Device {
  readonly id: string;
  readonly keys: PushDevice;
  gone: boolean;
}

interface Received {
  readonly device: string;
  readonly text: string;
}

export interface Harness {
  handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean>;
}

export interface HarnessOptions {
  readonly hub: Hub;
  readonly publicUrl: string;
  readonly hubUrl: string;
  readonly assertion: () => Promise<string>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${text}\n`);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

export function createHarness(options: HarnessOptions): Harness {
  const devices = new Map<string, Device>();
  const received: Received[] = [];

  const hold = (url: URL, response: ServerResponse): void => {
    const kind = url.searchParams.get("kind") ?? "repo";
    const command = url.searchParams.get("command") ?? heldCommands[kind];
    if (command === undefined) {
      json(response, 400, { error: "kind must be one of", kinds: Object.keys(heldCommands) });
      return;
    }
    const cwd = url.searchParams.get("cwd");
    const target = url.searchParams.get("target") ?? demoTargetName;
    const record = options.hub.commands.start({ target, command, ...(cwd === null ? {} : { cwd }) });
    json(response, 200, { id: record.id, state: record.state, command });
  };

  const moveTicket = (url: URL, response: ServerResponse): void => {
    const id = Number(url.searchParams.get("id"));
    const to = TicketState.safeParse(url.searchParams.get("to"));
    if (!Number.isInteger(id) || id <= 0 || !to.success) {
      json(response, 400, { error: "give id=<ticket> and to=<state>" });
      return;
    }
    const result = options.hub.tickets.move(id, to.data);
    json(response, result.ok ? 200 : 409, result.ok ? { id, state: result.ticket.state } : { id, error: result.error, state: result.ticket?.state ?? null });
  };

  const newDevice = async (response: ServerResponse): Promise<void> => {
    const publicKey = options.hub.push?.publicKey;
    if (publicKey === undefined) {
      json(response, 409, { error: "the hub has no VAPID keys" });
      return;
    }
    const id = randomUUID();
    const keys = createPushDevice();
    const device: Device = { id, keys, gone: false };
    devices.set(id, device);
    const endpoint = `${options.publicUrl}/__harness/push/${id}`;
    const answer = await fetch(`${options.hubUrl}/api/push/subscription`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: options.hubUrl, "cf-access-jwt-assertion": await options.assertion() },
      body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, applicationServerKey: publicKey }),
    });
    json(response, answer.ok ? 200 : 502, { id, endpoint, hub: answer.status });
  };

  return {
    handle: async (request, response, path) => {
      const url = new URL(request.url ?? "/", "http://page-dev");
      if (path === "/__harness/hold") {
        hold(url, response);
        return true;
      }
      if (path === "/__harness/ticket") {
        moveTicket(url, response);
        return true;
      }
      if (path === "/__harness/device/new") {
        await newDevice(response);
        return true;
      }
      const gone = /^\/__harness\/device\/([0-9a-f-]+)\/(gone|alive)$/.exec(path);
      if (gone?.[1] !== undefined) {
        const device = devices.get(gone[1]);
        if (device === undefined) {
          json(response, 404, { error: "unknown device" });
          return true;
        }
        device.gone = gone[2] === "gone";
        json(response, 200, { id: device.id, gone: device.gone });
        return true;
      }
      if (path === "/__harness/pushes") {
        json(response, 200, { received });
        return true;
      }
      const push = /^\/__harness\/push\/([0-9a-f-]+)$/.exec(path);
      if (push?.[1] !== undefined && request.method === "POST") {
        const body = await readBody(request);
        const device = devices.get(push[1]);
        if (device === undefined || device.gone) {
          response.writeHead(410, { "content-length": 0 });
          response.end();
          return true;
        }
        received.push({ device: device.id, text: receivePush(device.keys, body) });
        response.writeHead(201, { "content-length": 0 });
        response.end();
        return true;
      }
      return false;
    },
  };
}
