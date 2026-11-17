import type { AddressInfo } from "node:net";
import { createAccessVerifier, ownerOnly } from "./access.js";
import { brainTokenCheck, ensureBrainToken } from "./brain-token.js";
import { type Chains, createChains } from "./chains.js";
import { type Clock, systemClock } from "./clock.js";
import { allowEverything, type CommandGate, type CommandService, createCommandService } from "./commands.js";
import type { Config } from "./config.js";
import { type ConversationService, createConversationService } from "./conversations.js";
import { type CredentialSource, environmentCredentials } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { lockSettings } from "./irreversible.js";
import { createKeyCache, fetchKeySource, type KeySource } from "./keys.js";
import { type ConfirmationLock, createConfirmationLock } from "./lock.js";
import { pageFiles } from "./page.js";
import { createPushService, type PushService } from "./push-service.js";
import { createHubServer, type HubServer } from "./server.js";
import { createWaiting, type Waiting } from "./waiting.js";
import { createMachineStore, type MachineStore } from "./machines.js";
import { createRunners, type Runners } from "./runners.js";
import { combinedTargets, type Environment, fixedTargets, localTarget, sshTarget, type Target } from "./targets.js";
import { createToolServer } from "./tools.js";
import { commandIssueHost, createIssueFiler, type IssueHost } from "./filing.js";
import { createTicketService, type TicketService, type TicketWork } from "./tickets.js";
import { createStartDefaults, type StartDefaults, type SubscriptionAdjustment } from "./defaults.js";
import { createWorkService, type WorkService } from "./work.js";
import { createTicketFiles } from "./files.js";
import type { Fetch } from "./github-api.js";
import type { GeneratedText } from "@super-agent2/protocol";
import { createVerification, type Ticker, type VerificationService } from "./verification.js";
import { createFailureLoop, type FailureLoop } from "./failure-loop.js";

export interface HubOptions {
  readonly config: Config;
  readonly keySource?: KeySource;
  readonly clock?: Clock;
  readonly environment?: Environment;
  readonly targets?: readonly Target[];
  readonly credentials?: CredentialSource;
  readonly gate?: CommandGate;
  readonly pushFetch?: typeof fetch;
  readonly machinePollMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
  readonly issueHost?: IssueHost;
  readonly ticketWork?: TicketWork;
  readonly adjustSubscriptions?: SubscriptionAdjustment;
  readonly forgeFetch?: Fetch;
  readonly gitHubBase?: string;
  readonly verificationTicker?: Ticker;
  readonly verificationPollMilliseconds?: number;
}

export function defaultTargets(config: Config, environment: Environment): Target[] {
  const targets = [localTarget({ environment })];
  if (config.nas !== undefined) {
    targets.push(sshTarget(config.nas, environment));
  }
  return targets;
}

export interface Hub {
  readonly database: HubDatabase;
  readonly commands: CommandService;
  readonly conversations: ConversationService;
  readonly lock: ConfirmationLock | undefined;
  readonly waiting: Waiting;
  readonly push: PushService | undefined;
  readonly machines: MachineStore;
  readonly runners: Runners;
  readonly tickets: TicketService;
  readonly chains: Chains;
  readonly defaults: StartDefaults;
  readonly work: WorkService | undefined;
  readonly verification: VerificationService;
  readonly loop: FailureLoop;
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export async function startHub(options: HubOptions): Promise<Hub> {
  const clock = options.clock ?? systemClock;
  const { config } = options;
  const database = openDatabase({ dataDir: config.dataDir, clock });
  const environment = options.environment ?? process.env;
  const keys = createKeyCache({ source: options.keySource ?? fetchKeySource(config.accessTeam), clock });
  const verify = createAccessVerifier({ team: config.accessTeam, audience: config.accessAudience, keys, clock });
  let commands: CommandService;
  let conversations: ConversationService;
  let lock: ConfirmationLock | undefined;
  let waiting: Waiting;
  let push: PushService | undefined;
  let server: HubServer;
  let chains: Chains;
  let verification: VerificationService;
  let loop: FailureLoop | undefined;
  const machines = createMachineStore(database, clock);
  const runners = createRunners({
    machines,
    ...(options.machinePollMilliseconds === undefined ? {} : { pollMilliseconds: options.machinePollMilliseconds }),
  });
  const defaults = createStartDefaults({
    database,
    clock,
    statuses: () => runners.statuses(),
    ...(options.adjustSubscriptions === undefined ? {} : { adjust: options.adjustSubscriptions }),
  });
  let work: WorkService | undefined;
  const ticketWork: TicketWork = options.ticketWork ?? {
    begin: (ticket) => work?.begin(ticket),
    stop: (ticket) => work?.stop(ticket),
    reassign: (ticket) => work?.reassign(ticket),
  };
  const tickets = createTicketService({ database, clock, work: ticketWork });
  const files = createTicketFiles(database);
  const credentials = options.credentials ?? environmentCredentials(environment);
  const targets = combinedTargets(fixedTargets(options.targets ?? defaultTargets(config, environment)), runners);
  try {
    const brainToken = brainTokenCheck(ensureBrainToken(config.brainTokenFile));
    lock =
      options.gate === undefined
        ? createConfirmationLock({
            database,
            clock,
            verify,
            ownerEmail: config.ownerEmail,
            settings: lockSettings({ projectFolders: config.projectFolders, credentialPaths: config.credentialPaths }),
          })
        : undefined;
    commands = createCommandService({
      database,
      clock,
      targets,
      credentials,
      gate: options.gate ?? lock?.gate ?? allowEverything,
    });
    conversations = createConversationService({ database, clock, commands });
    const told = conversations;
    if (options.ticketWork === undefined) {
      work = createWorkService({
        database,
        clock,
        tickets,
        runners,
        credentials,
        files,
        tell: (conversation, notice, prompt) => {
          told.tell(conversation, notice, prompt);
        },
        deliver: (conversation, delivery) => {
          told.deliver(conversation, delivery);
        },
        report: (report) => loop?.failed(report),
      });
    }
    chains = createChains({
      database,
      clock,
      tickets,
      verify,
      ownerEmail: config.ownerEmail,
      defaults,
      tell: (conversation, notice, prompt) => {
        told.tell(conversation, notice, prompt);
      },
      work: ticketWork,
    });
    const worker = work;
    verification = createVerification({
      database,
      clock,
      tickets,
      credentials,
      fetch: options.forgeFetch ?? fetch,
      ...(options.gitHubBase === undefined ? {} : { gitHubBase: options.gitHubBase }),
      ...(options.verificationTicker === undefined ? {} : { ticker: options.verificationTicker }),
      ...(options.verificationPollMilliseconds === undefined ? {} : { pollMilliseconds: options.verificationPollMilliseconds }),
      tell: (conversation, notice, prompt) => {
        told.tell(conversation, notice, prompt);
      },
      report: (report) => loop?.failed(report),
      ...(worker === undefined
        ? {}
        : {
            sendBack: (ticket: number, note: string, reason: GeneratedText) => {
              const outcome = worker.again(ticket, note, reason);
              return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
            },
          }),
    });
    const listed = chains;
    const checked = verification;
    const failures = createFailureLoop({
      tickets,
      work: () => worker,
      verification: () => checked,
      tell: (conversation, notice, prompt) => {
        told.tell(conversation, notice, prompt);
      },
      verify,
      ownerEmail: config.ownerEmail,
    });
    loop = failures;
    waiting = createWaiting({ commands, lock, tickets, starts: () => listed.cards(), stuck: () => failures.cards() });
    const refreshed = waiting;
    runners.subscribe(() => refreshed.refresh());
    defaults.subscribe(() => refreshed.refresh());
    push =
      config.vapid === undefined
        ? undefined
        : createPushService({ database, clock, settings: config.vapid, fetch: options.pushFetch ?? fetch, waiting });
    server = createHubServer({
      database,
      commands,
      verify,
      admit: ownerOnly(config.ownerEmail),
      conversations,
      waiting,
      tools: createToolServer({
        commands,
        conversations,
        targets: () => targets.names(),
        machines: () => runners.describe(),
        tickets: {
          tickets,
          filer: createIssueFiler({ host: options.issueHost ?? commandIssueHost({ commands }), tickets, database, clock }),
          chains: chains.arranger,
          defaults,
          verification,
          loop: failures,
          ...(work === undefined ? {} : { work }),
        },
      }),
      tickets,
      files,
      ...(work === undefined ? {} : { work }),
      chains: chains.starter,
      loop: failures,
      defaults,
      brainToken,
      runners,
      ...(options.heartbeatMilliseconds === undefined ? {} : { heartbeatMilliseconds: options.heartbeatMilliseconds }),
      ...(push === undefined ? {} : { push }),
      ...(lock === undefined ? {} : { lock }),
      ...(config.pageDir === undefined ? {} : { page: pageFiles(config.pageDir) }),
    });
  } catch (error) {
    runners.close();
    database.close();
    throw error;
  }
  try {
    const failures = loop;
    if (failures === undefined) {
      throw new Error("The failure loop was not created");
    }
    work?.resume();
    const address = await server.listen(config.port, config.host);
    chains.resume();
    verification.resume();
    return {
      database,
      commands,
      conversations,
      lock,
      waiting,
      push,
      machines,
      runners,
      tickets,
      chains,
      defaults,
      work,
      verification,
      loop: failures,
      address,
      close: async () => {
        try {
          runners.close();
          await server.close();
        } finally {
          failures.close();
          verification.close();
          await verification.idle();
          work?.close();
          chains.close();
          await chains.idle();
          waiting.close();
          await push?.close();
          conversations.close();
          await commands.close();
          database.close();
        }
      },
    };
  } catch (error) {
    runners.close();
    verification.close();
    await verification.idle();
    work?.close();
    chains.close();
    waiting.close();
    await push?.close();
    conversations.close();
    await commands.close();
    database.close();
    throw error;
  }
}
