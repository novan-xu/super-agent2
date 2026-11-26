import { createOpenAICosts } from "./openai-costs.js";
import { createVoice } from "./voice.js";
import { codexMailFilter, type MailFilter } from "./mail-filter.js";
import { extraMcpFromEnvironment } from "./extra-mcp.js";
import { createModelDiscovery } from "./model-discovery.js";
import type { AddressInfo } from "node:net";
import { text } from "@super-agent2/catalog";
import { createAccessVerifier, ownerOnly } from "./access.js";
import { AppGateway } from "./app-gateway.js";
import { createAppTodos } from "./app-todos.js";
import { createMailIntake } from "./mail-intake.js";
import { createMailTriage, type MailTriage } from "./mail-triage.js";
import { brainTokenCheck, ensureBrainToken } from "./brain-token.js";
import { type Chains, createChains } from "./chains.js";
import { type Clock, type Sleep, systemClock } from "./clock.js";
import { allowEverything, type CommandGate, type CommandService, createCommandService } from "./commands.js";
import type { Config } from "./config.js";
import { type ConversationService, createConversationService } from "./conversations.js";
import { type CredentialSource, environmentCredentials, secretValues } from "./credentials.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { lockSettings } from "./irreversible.js";
import { createMemoryService, type MemoryService } from "./memories.js";
import { createKeyCache, fetchKeySource, type KeySource } from "./keys.js";
import { type ConfirmationLock, createConfirmationLock } from "./lock.js";
import { pageFiles } from "./page.js";
import { createPushService, type PushService } from "./push-service.js";
import { gitHubRelease } from "./release.js";
import { createHubServer, type HubServer } from "./server.js";
import { createWaiting, type Waiting } from "./waiting.js";
import { createMachineStore, type MachineStore } from "./machines.js";
import { createRunners, type Runners } from "./runners.js";
import { type Environment, fixedTargets, localTarget, type Target } from "./targets.js";
import { createToolServer } from "./tools.js";
import { commandIssueHost, createIssueFiler, type IssueHost } from "./filing.js";
import { createFollowUps, createFollowUpRecords } from "./follow-ups.js";
import { createTicketService, type TicketService, type TicketWork } from "./tickets.js";
import { createStartDefaults, type StartDefaults, type SubscriptionAdjustment } from "./defaults.js";
import { createWorkService, type WorkService } from "./work.js";
import { createTicketFiles } from "./files.js";
import { createLightTransfer } from "./transfer.js";
import { isAgentWringWriting } from "./agent-wring.js";
import { createTaskTickets, type TaskTickets } from "./task-tickets.js";
import { createLightTaskQuestions } from "./light-task-questions.js";
import { createLightTasks } from "./light-tasks.js";
import { createSchedules, type Schedules } from "./schedules.js";
import { type AttachmentStore, attachmentsFolder, createAttachmentStore } from "./attachments.js";
import type { Fetch } from "./github-api.js";
import { type GeneratedText, ticketReference } from "@super-agent2/protocol";
import { createVerification, type MergedPart, type Ticker, type VerificationService } from "./verification.js";
import { createFailureLoop, type FailureLoop } from "./failure-loop.js";
import { createDecisionReviews, type DecisionReviews } from "./reviews.js";
import type { AccessServiceTokens } from "./cloudflare.js";
import { createMachineAdmin, type MachineAdmin } from "./machine-admin.js";
import { createRepositoryDiscovery } from "./repository-discovery.js";
import { createRepositoryAccounts, type RepositoryAccounts } from "./repositories.js";
import { bgeSmallZh, modelScorer } from "@super-agent2/routing";
import type { ModelLoader } from "./topic-routing.js";
import { createSettings, type Settings } from "./settings.js";
import { createInbox } from "./inbox.js";
import { createTransferTools } from "./transfer-tools.js";
import { createHealthNotices } from "./health-notices.js";
import { createTopicTidy } from "./topic-tidy.js";
import { createWorkRequestServer } from "./work-requests.js";

export interface HubOptions {
  readonly config: Config;
  readonly appGateway?: AppGateway;
  readonly mailPollTicker?: Ticker;
  readonly mailTriageTicker?: Ticker;
  readonly mailFilter?: MailFilter;
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
  readonly liveFetch?: typeof fetch;
  readonly verificationTicker?: Ticker;
  readonly workTicker?: Ticker;
  readonly workSchedule?: (drain: () => void) => void;
  readonly scheduleTicker?: Ticker;
  readonly healthTicker?: Ticker;
  readonly topicTidyTicker?: Ticker;
  readonly verificationPollMilliseconds?: number;
  readonly serviceTokens?: AccessServiceTokens;
  readonly inboxServiceTokens?: AccessServiceTokens;
  readonly report?: (line: string) => void;
  readonly routingModel?: ModelLoader;
  readonly routingSleep?: Sleep;
}

export function scheduleWorkDrain(drain: () => void): void {
  setImmediate(drain);
}

const accessCheckMilliseconds = 60 * 60 * 1000;
const repositoryRefreshMilliseconds = 60 * 60 * 1000;

export function defaultTargets(environment: Environment): Target[] {
  return [localTarget({ environment })];
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
  readonly reviews: DecisionReviews;
  readonly taskTickets: TaskTickets;
  readonly schedules: Schedules;
  readonly memories: MemoryService;
  readonly admin: MachineAdmin;
  readonly repositories: RepositoryAccounts;
  readonly settings: Settings;
  readonly attachments: AttachmentStore;
  readonly address: AddressInfo;
  readonly workRequestAddress?: AddressInfo;
  close(): Promise<void>;
}

export async function startHub(options: HubOptions): Promise<Hub> {
  const clock = options.clock ?? systemClock;
  const { config } = options;
  const environment = options.environment ?? process.env;
  const appGateway = options.appGateway ?? (config.appGateway ? new AppGateway({
    cwd: config.dataDir,
    environment,
    report: options.report ?? ((line) => process.stderr.write(`${line}\n`)),
  }) : undefined);
  const mailEnabled = appGateway !== undefined && (config.mailIntake ?? (config.appGateway === true));
  const extraMcp = extraMcpFromEnvironment(environment);
  const database = openDatabase({ dataDir: config.dataDir, clock, ...(config.ticketTimeZone === undefined ? {} : { ticketTimeZone: config.ticketTimeZone }) });
  const keys = createKeyCache({ source: options.keySource ?? fetchKeySource(config.accessTeam), clock });
  const verify = createAccessVerifier({ team: config.accessTeam, audience: config.accessAudience, keys, clock });
  const verifyRunner = config.accessRunnerAudience === undefined ? verify : createAccessVerifier({ team: config.accessTeam, audience: config.accessRunnerAudience, keys, clock });
  const verifyInbox = config.accessInboxAudience === undefined ? undefined : createAccessVerifier({ team: config.accessTeam, audience: config.accessInboxAudience, keys, clock });
  const verifyMcp = config.accessMcpAudience === undefined ? undefined : createAccessVerifier({ team: config.accessTeam, audience: config.accessMcpAudience, keys, clock });
  let commands: CommandService;
  let conversations: ConversationService;
  let lock: ConfirmationLock | undefined;
  let waiting: Waiting;
  let push: PushService | undefined;
  let health: ReturnType<typeof createHealthNotices> | undefined;
  let server: HubServer;
  let chains: Chains;
  let schedules: Schedules;
  let topicTidy: ReturnType<typeof createTopicTidy> | undefined;
  let mailIntake: ReturnType<typeof createMailIntake> | undefined;
  let mailTriage: MailTriage | undefined;
  let verification: VerificationService;
  let loop: FailureLoop | undefined;
  let reviews: DecisionReviews;
  let taskTickets: TaskTickets;
  let memories: MemoryService;
  let settings: Settings;
  const machines = createMachineStore(database, clock);
  const runners = createRunners({
    machines,
    now: () => clock.now(),
    ...(config.version === undefined ? {} : { version: config.version }),
    ...(options.machinePollMilliseconds === undefined ? {} : { pollMilliseconds: options.machinePollMilliseconds }),
  });
  const defaults = createStartDefaults({
    database,
    clock,
    statuses: () => runners.statuses(),
    ...(config.deepseekLowBalance === undefined ? {} : { lowBalance: config.deepseekLowBalance }),
    providerOrder: () => settings?.workerOrder(),
    ...(options.adjustSubscriptions === undefined ? {} : { adjust: options.adjustSubscriptions }),
  });
  const openaiCosts = environment.OPENAI_ADMIN_KEY?.trim() ? createOpenAICosts({ key: environment.OPENAI_ADMIN_KEY, timeZone: database.ticketTimeZone, now: () => clock.now(), changed: () => defaults.changed(), report: options.report ?? ((line) => process.stderr.write(`${line}\n`)) }) : undefined;
  const openaiCost = openaiCosts === undefined ? undefined : () => openaiCosts.reading(settings?.budget() ?? null);
  runners.subscribe(() => defaults.changed());
  let work: WorkService | undefined;
  const ticketWork: TicketWork = options.ticketWork ?? {
    begin: (ticket) => work?.begin(ticket),
    stop: (ticket) => work?.stop(ticket),
    reassign: (ticket) => work?.reassign(ticket),
  };
  const tickets = createTicketService({ database, clock, machines: () => runners.statuses(), work: ticketWork, topicChanged: (id) => conversations.announce(id), entryChanged: (id) => conversations.announceEntry(id) });
  const repositories = createRepositoryAccounts(database, clock, config.sourceRepository);
  const accountOf = (repository: string) => repositories.accountOf(repository);
  let settingsChanged = () => undefined as void;
  let tellOwner: (notice: string, prompt: string) => void = () => undefined;
  const admin = createMachineAdmin({
    clock,
    machines,
    revoke: (name) => {
      runners.revoke(name);
    },
    tokens: options.serviceTokens,
    version: config.version !== undefined && config.sourceRepository !== undefined ? config.version : undefined,
    report: options.report ?? ((line) => process.stderr.write(`${line}\n`)),
    changed: () => settingsChanged(),
    tell: (notice, prompt) => tellOwner(notice, prompt),
  });
  const files = createTicketFiles(database);
  const storeLightTransfer = createLightTransfer(database);
  const lightQuestions = createLightTaskQuestions(database);
  const attachments = createAttachmentStore(database, clock, config.attachmentsDir ?? attachmentsFolder(config.dataDir));
  const lightTasks = createLightTasks(database, tickets, (id, materials) => {
    attachments.grant(id, materials.flatMap((piece) => piece.attachment == null ? [] : [piece.attachment]));
  });
  const credentials = options.credentials ?? environmentCredentials(environment);
  const repositoryDiscovery = createRepositoryDiscovery({
    repositories,
    credentials,
    clock,
    fetch: options.forgeFetch ?? fetch,
    ...(options.gitHubBase === undefined ? {} : { base: options.gitHubBase }),
    changed: () => settingsChanged(),
    report: options.report ?? ((line) => process.stderr.write(`${line}\n`)),
  });
  const targets = fixedTargets(options.targets ?? defaultTargets(environment));
  try {
    const brainSecret = ensureBrainToken(config.brainTokenFile);
    const brainToken = brainTokenCheck(brainSecret);
    const vapidKey = config.vapid?.privateKey;
    memories = createMemoryService({ database, clock, secrets: () => secretValues(environment, [...extraMcp.brain, ...extraMcp.workers].map((server) => server.token).concat(vapidKey === undefined ? [brainSecret] : [brainSecret, vapidKey])) });
    lock =
      options.gate === undefined
        ? createConfirmationLock({
            database,
            clock,
            verify,
            ownerEmail: config.ownerEmail,
            settings: lockSettings({ projectFolders: config.projectFolders }),
          })
        : undefined;
    commands = createCommandService({
      database,
      clock,
      targets,
      credentials,
      gate: options.gate ?? lock?.gate ?? allowEverything,
    });
    const routingModels = config.routingModels;
    conversations = createConversationService({
      extraMcp: extraMcp.brain,
      mailReviewEnabled: mailEnabled,
      lightTaskContext: (topic, message) => lightQuestions.context(topic, message),
      startCards: () => chains?.cards() ?? [],
      database, clock, commands, tickets, memory: memories, archiveMilliseconds: config.topicArchiveMilliseconds, order: () => settings?.brainOrder(),
      routing: {
        primary: config.routingPrimary,
        model: options.routingModel ?? (routingModels === undefined ? undefined : () => modelScorer(bgeSmallZh, { directory: routingModels, offline: true })),
        sleep: options.routingSleep,
        report: options.report ?? ((line) => process.stderr.write(`${line}
`)),
      },
    });
    const told = conversations;
    const modelDiscovery = createModelDiscovery(database, defaults, (notice, prompt) => told.tell(null, notice, prompt));
    modelDiscovery.scan(runners.statuses());
    runners.subscribe(() => modelDiscovery.scan(runners.statuses()));
    tellOwner = (notice, prompt) => {
      told.tell(null, notice, prompt);
    };
    if (options.ticketWork === undefined) {
      work = createWorkService({
        database,
        clock,
        tickets,
        runners,
        credentials,
        extraMcp: extraMcp.workers,
        files,
        attachments,
        defaults,
        ...(options.workTicker === undefined ? {} : { ticker: options.workTicker }),
        ...(config.workerSilenceMinutes === undefined ? {} : { silenceMinutes: config.workerSilenceMinutes }),
        schedule: options.workSchedule ?? scheduleWorkDrain,
        log: options.report ?? ((line) => process.stderr.write(`${line}\n`)),
        tell: told.tell,
        deliver: told.deliver,
        lightQuestions,
        lightQuestion: (ticket, attempt, event) => {
          const topic = ticket.conversation;
          if (topic === null) return undefined;
          const entry = lightQuestions.ask(ticket.id, attempt, event.id, (id) => told.writeLightQuestion(topic, id, event.text));
          return entry === undefined ? undefined : () => told.announceEntry(entry);
        },
        lightDelivery: (ticket, attempt, event) => {
          if (ticket.conversation === null) throw new Error("A light task must have a conversation.");
          const article = isAgentWringWriting(ticket);
          const delivered = ticket.light === "agent_wring" && !article ? [] : event.files;
          if (delivered.length > 0) {
            storeLightTransfer(ticket.id, attempt, ticket.title.zh, article ? "" : event.text ?? event.report.zh, delivered,
              (part) => files.stagedPath(ticket.id, attempt, part), clock.now());
          }
          const entry = told.writeDelivery(ticket.conversation, {
            ticket: ticket.id, title: ticket.title, report: article ? undefined : event.report,
            text: article ? null : ticket.light === "agent_wring" && event.text !== null ? `${event.report.zh}\n\n${event.text}` : event.text,
            files: delivered.map(({ name, size }) => ({ name, size })), light: true, prompt: "",
          });
          return () => {
            told.announceEntry(entry);
            if (delivered.length > 0) server?.transferChanged();
          };
        },
        report: (report) => loop?.failed(report),
        accountOf,
      });
      work.subscribe(told.taskProgress);
    }
    chains = createChains({
      database,
      clock,
      tickets,
      verify,
      ownerEmail: config.ownerEmail,
      defaults,
      tell: told.tell,
      work: ticketWork,
    });
    schedules = createSchedules({
      database, clock, conversations, tickets, chains, owner: config.ownerEmail, ticker: options.scheduleTicker,
      report: options.report ?? ((line) => process.stderr.write(`${line}\n`)),
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
      tell: told.tell,
      report: (report) => loop?.failed(report),
      accountOf,
      ...(config.firstPipelineAllowanceMinutes === undefined ? {} : { firstAllowanceMinutes: config.firstPipelineAllowanceMinutes }),
      ...(worker === undefined
        ? {}
        : {
            sendBack: (ticket: number, note: string, reason: GeneratedText) => {
              const outcome = worker.again(ticket, note, reason);
              return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
            },
            onward: (ticket: number, merged: MergedPart) => {
              const outcome = worker.onward(ticket, merged);
              return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
            },
            resumeOpenIssues: (ticket: number, note: string) => worker.again(ticket, note),
          }),
    });
    const listed = chains;
    const checked = verification;
    const failures = createFailureLoop({
      tickets,
      work: () => worker,
      verification: () => checked,
      tell: told.tell,
      verify,
      ownerEmail: config.ownerEmail,
    });
    loop = failures;
    reviews = createDecisionReviews({
      tickets,
      tell: told.tell,
    });
    taskTickets = createTaskTickets({
      database,
      tickets,
      attachments,
      credentials,
      fetch: options.forgeFetch ?? fetch,
      ...(options.gitHubBase === undefined ? {} : { gitHubBase: options.gitHubBase }),
      accountOf,
      marked: (ticket, _deployed, notes) => {
        if (notes.length > 0) {
          told.tell(
            ticket.id,
            text("notice.deploymentUnclear", { ticket: ticket.code }),
            [`[hub] Task ticket ${ticketReference(ticket)} (${ticket.title.en}) deployed ${ticket.repository ?? ""}, but not every merged ticket could be checked against what it deployed:`, ...notes, "Those tickets stay unmarked; if they are in fact deployed, record it with report_deployment so what waits for them begins."].join("\n"),
          );
        }
      },
    });
    const linkedConversations = conversations;
    settings = createSettings({
      database,
      clock,
      runners,
      admin,
      repositories,
      conversations: () => linkedConversations,
      defaults,
      credentials,
      pushKey: config.vapid?.publicKey,
      ...(appGateway === undefined ? {} : { appGateway: () => {
        const status = appGateway.status();
        return { ...status, mailboxes: mailIntake?.status() ?? status.mailboxes };
      } }),
    });
    const current = settings;
    settingsChanged = () => current.changed();
    waiting = createWaiting({ commands, lock, tickets, starts: () => listed.cards(), stuck: () => failures.cards() });
    const refreshed = waiting;
    runners.subscribe(() => refreshed.refresh());
    defaults.subscribe(() => refreshed.refresh());
    push =
      config.vapid === undefined
        ? undefined
        : createPushService({ database, clock, settings: config.vapid, fetch: options.pushFetch ?? fetch, waiting });
    if (appGateway !== undefined && mailEnabled) {
      const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
      mailTriage = createMailTriage({ database, clock, conversations, push, filter: options.mailFilter ?? codexMailFilter(process.cwd(), environment), memory: () => memories.list().map(({ text }) => text).join("\n"), ticker: options.mailTriageTicker, report });
      mailIntake = createMailIntake({
        database, clock, gateway: appGateway, ownerEmail: config.ownerEmail, ticker: options.mailPollTicker, report,
        writeNotice: mailTriage.writeNotice, changed: () => { settingsChanged(); mailTriage?.pump(); },
      });
    }
    health = createHealthNotices({ database, clock, runners, defaults, conversations, push, ticker: options.healthTicker, report: options.report ?? ((line) => process.stderr.write(`${line}\n`)) });
    server = createHubServer({
      ...(config.converterUrl === undefined ? {} : { converterUrl: config.converterUrl }),
      database,
      commands,
      verify,
      verifyRunner,
      ...(verifyInbox === undefined ? {} : { verifyInbox }),
      ...(verifyMcp === undefined ? {} : { verifyMcp }),
      ...(verifyInbox === undefined && verifyMcp === undefined ? {} : { inbox: createInbox({ database, clock, conversations, tokens: options.inboxServiceTokens, push }) }),
      admit: ownerOnly(config.ownerEmail),
      conversations,
      waiting,
      schedules,
      tools: createToolServer({
        commands,
        conversations,
        memories,
        attachments,
        transferTools: createTransferTools(database, attachments),
        ...(appGateway === undefined ? {} : { appGateway, appTodos: createAppTodos(database, clock) }),
        ...(mailTriage === undefined ? {} : { mailTriage }),
        tickets: {
          tickets,
          tasks: taskTickets,
          light: lightTasks,
          schedules,
          filer: createIssueFiler({ host: options.issueHost ?? commandIssueHost({ commands }), tickets, database, clock, accountOf }),
          followUp: createFollowUps({ records: createFollowUpRecords(database), tickets, credentials, accountOf, fetch: options.forgeFetch ?? fetch, base: options.gitHubBase }),
          chains: chains.arranger,
          defaults,
          ...(openaiCost === undefined ? {} : { openaiCost }),
          runners,
          verification,
          loop: failures,
          ...(work === undefined ? {} : { work }),
        },
      }),
      tickets,
      files,
      attachments,
      memories,
      settings,
      ...(openaiCost === undefined ? {} : { openaiCost, refreshOpenAICost: () => { void openaiCosts?.refresh(); } }),
      admin,
      repositories,
      voice: createVoice({
        clock, conversations, topics: conversations.topics, repositories, credentials,
        fetch: options.forgeFetch ?? fetch, base: options.gitHubBase,
        apiKey: environment.OPENAI_API_KEY, model: environment.HUB_VOICE_DELEGATION_MODEL?.trim() || undefined,
        liveFetch: options.liveFetch,
      }),
      refreshRepositories: repositoryDiscovery.refresh,
      ...(work === undefined ? {} : { work }),
      chains: chains.starter,
      loop: failures,
      reviews,
      defaults,
      brainToken,
      runners,
      ...(config.version === undefined ? {} : { version: config.version }),
      ...(config.version === undefined || config.sourceRepository === undefined
        ? {}
        : {
            release: gitHubRelease({
              repository: config.sourceRepository,
              version: config.version,
              credentials,
              accountOf,
              fetch: options.forgeFetch ?? fetch,
              ...(options.gitHubBase === undefined ? {} : { base: options.gitHubBase }),
            }),
          }),
      ...(options.heartbeatMilliseconds === undefined ? {} : { heartbeatMilliseconds: options.heartbeatMilliseconds }),
      ...(push === undefined ? {} : { push }),
      ...(lock === undefined ? {} : { lock }),
      ...(config.pageDir === undefined ? {} : { page: pageFiles(config.pageDir) }),
    });
  } catch (error) {
    topicTidy?.close();
    health?.close();
    runners.close();
    database.close();
    throw error;
  }
  let address: AddressInfo | undefined;
  let closeWorkRequests: (() => Promise<void>) | undefined;
  try {
    const failures = loop;
    if (failures === undefined) {
      throw new Error("The failure loop was not created");
    }
    work?.resume();
    address = await server.listen(config.port, config.host);
    let workRequestAddress: AddressInfo | undefined;
    if (config.workRequests !== undefined) {
      const { port, directory } = config.workRequests;
      const workRequests = createWorkRequestServer(directory, schedules, options.report ?? ((line) => process.stderr.write(`${line}\n`)));
      workRequestAddress = await workRequests.listen(port, config.host);
      closeWorkRequests = workRequests.close;
    }
    chains.resume();
    verification.resume();
    taskTickets.resume();
    schedules.resume();
    topicTidy = createTopicTidy({ database, clock, conversations, time: config.topicTidyTime, enabled: config.topicTidyEnabled,
      ticker: options.topicTidyTicker, report: options.report ?? ((line) => process.stderr.write(`${line}\n`)) });
    const warn = () => {
      try {
        admin.warnExpiring();
      } catch (error) {
        (options.report ?? ((line: string) => process.stderr.write(`${line}
`)))(`Checking the machines' access tokens failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    warn();
    const accessCheck = setInterval(warn, accessCheckMilliseconds);
    accessCheck.unref();
    const sweepRepositories = () => {
      if (repositories.sweepInactive() > 0) settingsChanged();
    };
    sweepRepositories();
    const repositorySweep = setInterval(sweepRepositories, 15 * 60_000);
    repositorySweep.unref();
    void repositoryDiscovery.refresh();
    const repositoryRefresh = setInterval(() => void repositoryDiscovery.refresh(), repositoryRefreshMilliseconds);
    repositoryRefresh.unref();
    mailTriage?.start();
    appGateway?.start(() => {
      settingsChanged();
      void mailIntake?.poll().catch(() => options.report?.("Mail intake: storage failure"));
    });
    mailIntake?.start();
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
      reviews,
      taskTickets,
      schedules,
      memories,
      admin,
      repositories,
      settings,
      attachments,
      address,
      ...(workRequestAddress === undefined ? {} : { workRequestAddress }),
      close: async () => {
        openaiCosts?.close();
        topicTidy?.close();
        mailIntake?.close();
        mailTriage?.close();
        health?.close();
        clearInterval(accessCheck);
        clearInterval(repositoryRefresh);
        clearInterval(repositorySweep);
        schedules.close();
        repositoryDiscovery.close();
        settings.close();
        try {
          await appGateway?.close();
          await mailIntake?.idle();
          runners.close();
          await Promise.all([server.close(), closeWorkRequests?.()]);
        } finally {
          taskTickets.close();
          await taskTickets.idle();
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
    topicTidy?.close();
    mailIntake?.close();
    mailTriage?.close();
    health?.close();
    runners.close();
    schedules?.close();
    await appGateway?.close();
    await mailIntake?.idle();
    await Promise.allSettled([address === undefined ? undefined : server.close(), closeWorkRequests?.()]);
    taskTickets.close();
    await taskTickets.idle();
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
