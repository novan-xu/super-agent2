import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBrain, createHubLink, type ProgramAdapter, prepareWorkspace, programAdapter, startingModels, systemClock } from "@super-agent2/brain";
import { defaultPageDir, generateVapidKeys, localTarget, startHub, type VapidKeys } from "@super-agent2/hub";
import { type AccessKeySet, brainToolsPath, type Provider } from "@super-agent2/protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { demoProgram } from "./demo.js";
import { createHarness, demoTarget } from "./harness.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5180" },
    data: { type: "string", default: ".state/page-dev" },
    brain: { type: "string", default: "demo" },
    model: { type: "string" },
    fresh: { type: "boolean", default: false },
    push: { type: "string", default: "generated" },
  },
});

const team = "page-dev";
const audience = "d".repeat(64);
const ownerEmail = "owner@example.com";
const port = Number(values.port);
const dataDir = resolve(values.data);
const brainKind = values.brain;

if (brainKind !== "demo" && brainKind !== "claude" && brainKind !== "none") {
  process.stderr.write("--brain must be demo, claude or none\n");
  process.exit(1);
}

if (values.push !== "generated" && values.push !== "none") {
  process.stderr.write("--push must be generated or none\n");
  process.exit(1);
}

if (values.fresh) {
  rmSync(dataDir, { recursive: true, force: true });
}
const hubDir = join(dataDir, "hub");
const workspace = join(dataDir, "workspace");
mkdirSync(hubDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

const pair = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "page-dev", alg: "RS256", use: "sig" };
const keys: AccessKeySet = { keys: [{ ...jwk, kty: String(jwk.kty), kid: "page-dev" }] };

let signed: { readonly token: string; readonly until: number } | undefined;

async function ownerAssertion(): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  if (signed !== undefined && signed.until > seconds + 60) {
    return signed.token;
  }
  const token = await new SignJWT({ iss: `https://${team}.cloudflareaccess.com`, aud: [audience], email: ownerEmail, sub: "page-dev-owner", iat: seconds, exp: seconds + 600 })
    .setProtectedHeader({ alg: "RS256", kid: "page-dev", typ: "JWT" })
    .sign(pair.privateKey);
  signed = { token, until: seconds + 600 };
  return token;
}

async function serviceAssertion(clientId: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: `https://${team}.cloudflareaccess.com`, aud: [audience], common_name: clientId, sub: "", type: "app", iat: seconds, exp: seconds + 600 })
    .setProtectedHeader({ alg: "RS256", kid: "page-dev", typ: "JWT" })
    .sign(pair.privateKey);
}

function assertionFor(incoming: IncomingMessage): Promise<string> {
  const clientId = incoming.headers["cf-access-client-id"];
  const clientSecret = incoming.headers["cf-access-client-secret"];
  if (typeof clientId === "string" && clientId !== "" && typeof clientSecret === "string" && clientSecret !== "") {
    return serviceAssertion(clientId);
  }
  return ownerAssertion();
}

const replacedHeaders = new Set(["cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]);

function vapidKeys(): VapidKeys | undefined {
  if (values.push === "none") {
    return undefined;
  }
  const file = join(dataDir, "vapid.json");
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
  }
  const keys = generateVapidKeys();
  writeFileSync(file, JSON.stringify(keys));
  return keys;
}

const vapid = vapidKeys();

const hub = await startHub({
  config: {
    accessTeam: team,
    accessAudience: audience,
    ownerEmail,
    dataDir: hubDir,
    port: 0,
    host: "127.0.0.1",
    projectFolders: [],
    credentialPaths: [],
    brainTokenFile: join(hubDir, "brain.token"),
    pageDir: defaultPageDir,
    ...(vapid === undefined ? {} : { vapid }),
  },
  keySource: () => Promise.resolve(keys),
  targets: [localTarget({ environment: process.env }), demoTarget()],
  credentials: () => ({ ok: true, credentials: {} }),
});
const hubPort = hub.address.port;
const hubUrl = `http://127.0.0.1:${hubPort}`;

async function startBrain(): Promise<(() => Promise<void>) | undefined> {
  if (brainKind === "none") {
    return undefined;
  }
  prepareWorkspace(workspace);
  const token = readFileSync(join(hubDir, "brain.token"), "utf8").trim();
  const provider: Provider = "claude";
  const adapter: ProgramAdapter =
    brainKind === "demo"
      ? demoProgram()
      : programAdapter("claude", {
          program: startingModels.claude.program,
          model: values.model ?? startingModels.claude.model,
          effort: startingModels.claude.effort,
          environment: process.env,
          clock: systemClock,
        });
  const link = createHubLink({ hubUrl, token, report: (line) => process.stdout.write(`<link> ${line}\n`) });
  const brain = createBrain({
    adapters: new Map([[provider, adapter]]),
    order: [provider],
    transport: link,
    clock: systemClock,
    tools: { url: `${hubUrl}${brainToolsPath}`, token },
    workspace,
  });
  link.bind({ receive: (message) => brain.receive(message), running: () => brain.running() });
  link.connect();
  return async () => {
    await link.close();
    await brain.close();
  };
}

const stopBrain = await startBrain();

let offline = false;
const open = new Set<Socket>();

function forwardHeaders(incoming: IncomingMessage, assertion: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && !replacedHeaders.has(name)) {
      headers[name] = value;
    }
  }
  headers["cf-access-jwt-assertion"] = assertion;
  return headers;
}

const harness = createHarness({ hub, publicUrl: `http://127.0.0.1:${port}`, hubUrl, assertion: ownerAssertion });

const proxy = createServer((incoming, outgoing) => {
  const path = new URL(incoming.url ?? "/", "http://page-dev").pathname;
  if (path.startsWith("/__harness/") && path !== "/__harness/offline" && path !== "/__harness/online") {
    void harness.handle(incoming, outgoing, path).then((handled) => {
      if (!handled) {
        outgoing.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("unknown harness path\n");
      }
    });
    return;
  }
  if (path === "/__harness/offline" || path === "/__harness/online") {
    offline = path.endsWith("offline");
    outgoing.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    outgoing.end(offline ? "offline\n" : "online\n");
    if (offline) {
      for (const socket of open) {
        if (socket !== incoming.socket) {
          socket.destroy();
        }
      }
    }
    return;
  }
  if (offline) {
    incoming.socket.destroy();
    return;
  }
  void assertionFor(incoming).then((assertion) => {
    const upstream = request(
      { host: "127.0.0.1", port: hubPort, method: incoming.method, path: incoming.url, headers: forwardHeaders(incoming, assertion) },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
});

proxy.on("connection", (socket: Socket) => {
  open.add(socket);
  socket.on("close", () => open.delete(socket));
});

proxy.on("upgrade", (incoming: IncomingMessage, socket: Socket, head: Buffer) => {
  if (offline) {
    socket.destroy();
    return;
  }
  void assertionFor(incoming).then((assertion) => {
    const upstream = request({ host: "127.0.0.1", port: hubPort, method: incoming.method, path: incoming.url, headers: forwardHeaders(incoming, assertion) });
    upstream.on("upgrade", (answer, upstreamSocket: Socket, upstreamHead: Buffer) => {
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
    });
    upstream.on("response", (answer) => {
      socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
});

await new Promise<void>((done) => proxy.listen(port, "127.0.0.1", done));

process.stdout.write(
  [
    `Page:     http://127.0.0.1:${port}/`,
    `Hub:      ${hubUrl} (behind the proxy, which signs every request as ${ownerEmail})`,
    `Brain:    ${brainKind}`,
    `Data:     ${dataDir}`,
    `Offline:  http://127.0.0.1:${port}/__harness/offline, back with /__harness/online`,
    `Runners:  a request with CF-Access-Client-Id and CF-Access-Client-Secret is signed as that service token, as Cloudflare would; add a machine with HUB_DATA_DIR=${hubDir} node packages/hub/dist/machines-cli.js add <name> --hub http://127.0.0.1:${port} --access-client-id <any id>`,
    `Hold:     http://127.0.0.1:${port}/__harness/hold?kind=repo (also branch, data, file, long, hidden, or ?command=...), run on the pretend target demo`,
    `Tickets:  http://127.0.0.1:${port}/__harness/ticket?id=<ticket>&to=<state> moves a ticket as a worker or a merge would (verifying, then merged)`,
    `Push:     ${vapid === undefined ? "off (--push none)" : `VAPID keys in ${join(dataDir, "vapid.json")}`}; a pretend device at /__harness/device/new, what it received at /__harness/pushes, expiry at /__harness/device/<id>/gone`,
    "",
  ].join("\n"),
);

let stopping = false;
const stop = () => {
  if (stopping) {
    return;
  }
  stopping = true;
  proxy.close();
  for (const socket of open) {
    socket.destroy();
  }
  void (async () => {
    await stopBrain?.();
    await hub.close();
    process.exit(0);
  })();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
