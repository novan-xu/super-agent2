import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBrain, createHubLink, type ProgramAdapter, prepareWorkspace, programAdapter, startingModels, systemClock } from "@super-agent2/brain";
import { defaultPageDir, environmentCredentials, fakeForge, fakeGitHubBase, fakeWoodpeckerServer, generateVapidKeys, type Hub, localTarget, startHub, type VapidKeys } from "@super-agent2/hub";
import { type AccessKeySet, brainToolsPath, enrollPath, fullOrder, type Provider, startingOrder } from "@super-agent2/protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { demoProgram } from "./demo.js";
import { createAllowanceForcing, createHarness, demoTarget, fakeServiceTokens, forgeHandBack } from "./harness.js";
import { createScriptedRunners } from "./scripted.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5180" },
    data: { type: "string", default: ".state/page-dev" },
    brain: { type: "string", default: "demo" },
    model: { type: "string" },
    fresh: { type: "boolean", default: false },
    push: { type: "string", default: "generated" },
    credentials: { type: "string", default: "none" },
    forge: { type: "string", default: "none" },
    announce: { type: "string" },
    source: { type: "string", default: "novan-xu/super-agent2" },
    cloudflare: { type: "string", default: "fake" },
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

if (values.credentials !== "none" && values.credentials !== "environment" && values.credentials !== "placeholder") {
  process.stderr.write("--credentials must be none, environment or placeholder\n");
  process.exit(1);
}

if (values.forge !== "none" && values.forge !== "fake") {
  process.stderr.write("--forge must be none or fake\n");
  process.exit(1);
}

if (values.forge === "fake" && values.credentials === "environment") {
  process.stderr.write("--forge fake gives the hub placeholder tokens; it cannot be used with --credentials environment\n");
  process.exit(1);
}

if (values.announce !== undefined && !/^[0-9a-f]{40}$/.test(values.announce)) {
  process.stderr.write("--announce must be a full commit id\n");
  process.exit(1);
}

if (values.cloudflare !== "fake" && values.cloudflare !== "none") {
  process.stderr.write("--cloudflare must be fake or none\n");
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

function assertionFor(incoming: IncomingMessage): Promise<string | undefined> {
  if (new URL(incoming.url ?? "/", "http://page-dev").pathname.startsWith(enrollPath)) {
    return Promise.resolve(undefined);
  }
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
const cloudflare = values.cloudflare === "fake" ? fakeServiceTokens() : undefined;
const allowance = createAllowanceForcing();
const forge = values.forge === "fake" ? fakeForge() : undefined;

const hub = await startHub({
  config: {
    accessTeam: team,
    accessAudience: audience,
    ownerEmail,
    dataDir: hubDir,
    port: 0,
    host: "127.0.0.1",
    projectFolders: [],
    brainTokenFile: join(hubDir, "brain.token"),
    pageDir: defaultPageDir,
    ...(vapid === undefined ? {} : { vapid }),
    ...(values.announce === undefined ? {} : { version: values.announce, sourceRepository: values.source }),
  },
  keySource: () => Promise.resolve(keys),
  targets: [localTarget({ environment: process.env }), demoTarget()],
  credentials:
    forge !== undefined
      ? () => ({ ok: true, credentials: { GH_TOKEN: "page-dev-placeholder", GITHUB_TOKEN: "page-dev-placeholder", WOODPECKER_SERVER: fakeWoodpeckerServer, WOODPECKER_TOKEN: "page-dev-placeholder" } })
      : values.credentials === "environment"
        ? environmentCredentials(process.env)
        : values.credentials === "placeholder"
          ? () => ({ ok: true, credentials: { GH_TOKEN: "page-dev-placeholder", GITHUB_TOKEN: "page-dev-placeholder" } })
          : () => ({ ok: true, credentials: {} }),
  adjustSubscriptions: allowance.adjust,
  ...(cloudflare === undefined ? {} : { serviceTokens: cloudflare.tokens }),
  verificationPollMilliseconds: forge === undefined ? 10_000 : 2_000,
  ...(forge !== undefined
    ? { forgeFetch: forge.fetch, gitHubBase: fakeGitHubBase }
    : values.credentials === "environment"
      ? {}
      : { forgeFetch: (input: string | URL | Request) => Promise.reject(new Error(`The harness reaches no forge without --credentials environment: ${String(input instanceof Request ? input.url : input)}`)) }),
});
const hubPort = hub.address.port;
const hubUrl = `http://127.0.0.1:${hubPort}`;

async function startBrain(): Promise<(() => Promise<void>) | undefined> {
  if (brainKind === "none") {
    return undefined;
  }
  prepareWorkspace(workspace);
  const token = readFileSync(join(hubDir, "brain.token"), "utf8").trim();
  const adapters = new Map<Provider, ProgramAdapter>(
    brainKind === "demo"
      ? [
          ["gpt", demoProgram("gpt", "demo-gpt")],
          ["claude", demoProgram("claude", "demo-claude")],
          ["deepseek", demoProgram("deepseek", "demo-deepseek")],
        ]
      : [
          [
            "claude",
            programAdapter("claude", {
              program: startingModels.claude.program,
              model: values.model ?? startingModels.claude.model,
              effort: startingModels.claude.effort,
              environment: process.env,
              clock: systemClock,
            }),
          ],
        ],
  );
  const link = createHubLink({ hubUrl, token, report: (line) => process.stdout.write(`<link> ${line}\n`) });
  const brain = createBrain({
    adapters,
    order: brainKind === "demo" ? fullOrder(startingOrder) : ["claude"],
    transport: link,
    clock: systemClock,
    tools: { url: `${hubUrl}${brainToolsPath}`, token },
    workspace,
  });
  link.bind({ receive: (message) => brain.receive(message), running: () => brain.running(), status: () => brain.status() });
  link.connect();
  return async () => {
    await link.close();
    await brain.close();
  };
}

const stopBrain = await startBrain();

let offline = false;
const open = new Set<Socket>();

function forwardHeaders(incoming: IncomingMessage, assertion: string | undefined): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && !replacedHeaders.has(name)) {
      headers[name] = value;
    }
  }
  if (assertion !== undefined) {
    headers["cf-access-jwt-assertion"] = assertion;
  }
  return headers;
}

const running: Hub = hub;
const deployments = new Map<string, string>();
const scripted = createScriptedRunners(hub, forge === undefined ? undefined : forgeHandBack(forge, () => running, deployments));

const harness = createHarness({
  scripted,
  hub,
  publicUrl: `http://127.0.0.1:${port}`,
  hubUrl,
  assertion: ownerAssertion,
  allowance,
  ...(cloudflare === undefined ? {} : { cloudflare }),
  brainToken: () => readFileSync(join(hubDir, "brain.token"), "utf8").trim(),
  ...(forge === undefined ? {} : { deployments }),
});

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
    `Work:     http://127.0.0.1:${port}/__harness/work?repository=<owner/name>&issues=1,2&machine=<runner>&engine=codex&model=<model>&effort=<effort>[&after=<ticket>] files, arranges, chooses and starts a chain through the brain's tools and the owner's start; with --credentials environment the hub's GitHub tokens come from GITHUB_TOKEN_NOVAN_XU and GITHUB_TOKEN_NUOFAN_ISLAND, and verifying tickets are checked against GitHub every ten seconds`,
    `Tool:     http://127.0.0.1:${port}/__harness/tool?name=<tool>&args=<JSON> calls one of the brain's tools, for example merge_ticket`,
    `Writing:  http://127.0.0.1:${port}/__harness/writing?task=<English task>&text=<pasted material>&conversation=<id> opens a writing ticket through the brain's tools and states its defaults, to be started from its card on the page`,
    `Scenario: http://127.0.0.1:${port}/__harness/scenario opens and starts scripted tickets in two repositories and two writing tickets on the scripted machines studio and mini (needs --credentials placeholder or environment); /__harness/scripted?machine=mini&to=offline (or online) cuts or restores a scripted machine`,
    `History:  http://127.0.0.1:${port}/__harness/history?count=70 adds ended tickets (merged, delivered and stopped, across two repositories, a hundred minutes apart, newest first) and one that was joined into another and so is not listed; the scenario above ends tickets live`,
    `Loop:     http://127.0.0.1:${port}/__harness/loop?case=fixed (red pipeline once, then green), red (red every round), stuck (the worker fails every round) or worker (fails once), on the scripted machine studio; with --forge fake the hub reads GitHub and Woodpecker from a fake forge in this process, so a scripted pull request is verified, fails or merges there; the demo brain answers failures with guide_ticket and the cap with describe_stuck`,
    `Deploy:   POST a deployment file to http://127.0.0.1:${port}/__harness/deployment?repository=<owner/name> (with --forge fake) and every scripted pull request of that repository carries it from then on, so its merge needs deploying; /__harness/loop?case=green&repository=<owner/name> starts such a ticket, which merges green; the demo brain deploys what a merge says needs deploying with deploy_repository, and reports the result`,
    `Version:  ${values.announce === undefined ? "none announced (--announce <commit> makes the hub announce it to runners and hand them its release from --source, through GitHub with --credentials environment)" : `${values.announce} of ${values.source}, announced to runners`}`,
    `Machines: ${cloudflare === undefined ? "no Cloudflare credentials (--cloudflare none), so 添加机器 says so" : "添加机器 in 设置 makes Access service tokens in a fake Cloudflare in this process; /__harness/cloudflare?remove=fail makes revoking keep the token, ?remove=ok puts it back"}; ${enrollPath} reaches the hub with no assertion, as Cloudflare's Bypass rule would let it`,
    `Allowance: http://127.0.0.1:${port}/__harness/allowance?codex=exhausted&claude=exhausted forces the subscriptions as read; read puts back the runners' real reading`,
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
  scripted.close();
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
