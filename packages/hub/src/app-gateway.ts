import type { AppGatewayStatus } from "@super-agent2/protocol";
import { z } from "zod";
import { AppGatewayError, appRefusal, AppServer, type AppServerOptions } from "./app-server.js";

const readTools = new Set([
  "gmail.search_emails",
  "gmail.read_email",
  "microsoft_outlook_email.list_messages",
  "microsoft_outlook_email.search_messages",
  "microsoft_outlook_email.fetch_message",
  "microsoft_outlook_email.list_attachments",
  "microsoft_teams.list_chats",
  "microsoft_teams.list_chat_messages",
  "microsoft_teams.search",
  "microsoft_teams.list_teams",
  "microsoft_teams.list_channels",
  "microsoft_teams.list_channel_messages",
  "ticktick_to_do_list_calendar.list_projects",
  "ticktick_to_do_list_calendar.search_task",
  "ticktick_to_do_list_calendar.get_project_with_undone_tasks",
  "ticktick_to_do_list_calendar.get_task_by_id",
]);

export const appWrites = {
  gmailDraft: "gmail.create_draft",
  gmailUpdate: "gmail.update_draft",
  outlookDraft: "microsoft_outlook_email.draft_email",
  outlookReply: "microsoft_outlook_email.create_reply_draft",
} as const;

export const tickTickWrites = {
  create: "ticktick_to_do_list_calendar.batch_add_tasks",
  update: "ticktick_to_do_list_calendar.update_task",
  move: "ticktick_to_do_list_calendar.move_task",
  delete: "ticktick_to_do_list_calendar.delete_task",
  complete: "ticktick_to_do_list_calendar.complete_task",
  createProject: "ticktick_to_do_list_calendar.create_project",
} as const;
type TickTickWriteName = (typeof tickTickWrites)[keyof typeof tickTickWrites];
const syncWrites = new Set<string>(Object.values(tickTickWrites));

type AppWriteName = (typeof appWrites)[keyof typeof appWrites];
const writeTools = new Set<string>(Object.values(appWrites));

export class AppInputError extends Error {}

const Fields = z.record(z.string(), z.unknown());
const Link = z.object({
  link_id: z.string().min(1),
  profile_email: z.email().nullish().catch(undefined),
});
const Tool = z.object({
  name: z.string(),
  inputSchema: z.object({ properties: Fields.optional() }),
  annotations: z.object({ readOnlyHint: z.boolean() }),
  _meta: z.object({
    link_id: z.string().min(1).nullish(),
    link_accounts: z.array(Link).nullish(),
  }).optional(),
});
const Inventory = z.object({
  data: z.array(z.object({ name: z.string(), tools: Fields })),
  nextCursor: z.string().nullish(),
});
const Reply = z.object({
  isError: z.boolean().nullish(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
});

export interface Mailbox {
  readonly id: string;
  readonly provider: "outlook" | "gmail";
  readonly label: string;
  readonly email?: string;
  readonly link?: string;
}

function mailboxes(tools: ReadonlyMap<string, z.infer<typeof Tool>>): Mailbox[] {
  const outlook = new Map<string, Mailbox>();
  for (const name of ["microsoft_outlook_email.list_messages", "microsoft_outlook_email.search_messages", "microsoft_outlook_email.fetch_message"]) {
    const tool = tools.get(name);
    for (const link of tool?._meta?.link_accounts ?? []) {
      const email = link.profile_email ?? undefined;
      if (!outlook.has(link.link_id) || (email !== undefined && outlook.get(link.link_id)?.email === undefined)) {
        outlook.set(link.link_id, {
          id: `outlook:${link.link_id}`,
          provider: "outlook",
          label: email ?? `Outlook ${outlook.size + 1}`,
          ...(email === undefined ? {} : { email }),
          link: link.link_id,
        });
      }
    }
  }
  const gmail = tools.get("gmail.search_emails") ?? tools.get("gmail.read_email");
  if (gmail === undefined || Object.hasOwn(gmail.inputSchema.properties ?? {}, "link_id")) {
    return [...outlook.values()];
  }
  const connection = gmail._meta?.link_id;
  return [...outlook.values(), { id: connection ? `gmail:${connection}` : "gmail", provider: "gmail", label: "Gmail" }];
}

export interface AppGatewayOptions extends AppServerOptions {
  readonly report?: (line: string) => void;
}

const refreshMilliseconds = 5 * 60_000;

export class AppGateway {
  private readonly server: AppServer;
  private tools = new Map<string, z.infer<typeof Tool>>();
  private accounts: Mailbox[] = [];
  private refreshing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inventoryAvailable = false;

  constructor(private readonly options: AppGatewayOptions) {
    this.server = new AppServer(options);
  }

  start(changed: () => void): void {
    const revision = () => JSON.stringify([this.status(), [...this.tools.keys()].filter((name) => name.startsWith("ticktick_to_do_list_calendar."))
      .sort().map((name) => [name, this.connectionOf(name)])]);
    const refresh = () => {
      const before = revision();
      void this.refresh().then(() => {
        if (revision() !== before) {
          changed();
        }
      });
    };
    refresh();
    this.timer = setInterval(refresh, refreshMilliseconds);
    this.timer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.server.close();
    await this.refreshing;
  }

  status(): AppGatewayStatus {
    return {
      connected: this.tools.size > 0,
      mailboxes: this.accounts.map(({ provider, label }) => ({ provider, label })),
      teams: this.has("microsoft_teams.list_chats"),
      ticktick: this.has("ticktick_to_do_list_calendar.list_projects") || this.has("ticktick_to_do_list_calendar.search_task"),
    };
  }

  mailboxes(): readonly Mailbox[] {
    return this.accounts;
  }

  hasInventory(): boolean {
    return this.inventoryAvailable;
  }

  has(tool: string): boolean {
    return this.tools.has(tool);
  }

  connectionOf(tool: string): string | undefined {
    return this.tools.get(tool)?._meta?.link_id ?? undefined;
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.discover().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async discover(): Promise<void> {
    const tools = new Map<string, z.infer<typeof Tool>>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    let foundApps = false;
    try {
      do {
        const page = Inventory.safeParse(await this.server.request("mcpServerStatus/list", {
          detail: "full",
          ...(cursor === undefined ? {} : { cursor }),
        }));
        if (!page.success) {
          throw new AppGatewayError("invalid response");
        }
        const apps = page.data.data.find(({ name }) => name === "codex_apps");
        if (apps !== undefined) {
          foundApps = true;
          for (const [name, value] of Object.entries(apps.tools)) {
            if (!readTools.has(name) && !writeTools.has(name) && !syncWrites.has(name)) {
              continue;
            }
            const tool = Tool.safeParse(value);
            if (!tool.success || tool.data.name !== name || tool.data.annotations.readOnlyHint !== readTools.has(name)) {
              this.options.report?.(new AppGatewayError("invalid response").message);
              continue;
            }
            tools.set(name, tool.data);
          }
        }
        cursor = page.data.nextCursor ?? undefined;
        if (cursor !== undefined) {
          if (visited.has(cursor)) {
            throw new AppGatewayError("invalid response");
          }
          visited.add(cursor);
        }
      } while (cursor !== undefined);
      this.inventoryAvailable = foundApps;
    } catch (error) {
      this.options.report?.(error instanceof AppGatewayError ? error.message : new AppGatewayError("invalid response").message);
      tools.clear();
      this.inventoryAvailable = false;
    }
    this.tools = tools;
    this.accounts = mailboxes(tools);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!readTools.has(name)) {
      throw new AppGatewayError("tool not allowed");
    }
    if ((name === "microsoft_outlook_email.list_attachments" && (args["content_mode"] !== "metadata_only" || args["attachment_ids"] != null))
      || (name === "gmail.read_email" && args["format"] !== "full")) {
      throw new AppGatewayError("tool not allowed");
    }
    return this.callTool(name, args);
  }

  async write(name: AppWriteName, args: Record<string, unknown>, authorized: () => boolean): Promise<unknown> {
    if (!writeTools.has(name)) {
      throw new AppGatewayError("tool not allowed");
    }
    if (typeof authorized !== "function") {
      throw new AppGatewayError("owner request required");
    }
    return this.callTool(name, args, authorized);
  }

  async writeTickTick(name: TickTickWriteName, args: Record<string, unknown>, account: string, authorized: () => boolean): Promise<unknown> {
    if (!syncWrites.has(name)) throw new AppGatewayError("tool not allowed");
    const permitted = () => authorized() && this.connectionOf(name) === account;
    if (!permitted()) throw new AppGatewayError("owner request required");
    return this.callTool(name, args, permitted);
  }

  private async callTool(name: string, args: Record<string, unknown>, authorized?: () => boolean): Promise<unknown> {
    const available = () => {
      const tool = this.tools.get(name);
      return tool !== undefined && (!name.startsWith("microsoft_outlook_email.")
        || tool._meta?.link_accounts?.some(({ link_id }) => link_id === args["link_id"]) === true);
    };
    if (!available()) {
      throw new AppGatewayError("tool unavailable");
    }
    try {
      const response = Reply.safeParse(await this.server.request("mcpServer/tool/call", { server: "codex_apps", tool: name, arguments: args },
        authorized === undefined ? undefined : () => {
          if (!available()) throw new AppGatewayError("tool unavailable");
          return authorized();
        }));
      if (!response.success) {
        throw new AppGatewayError("invalid response");
      }
      const { isError, structuredContent, content } = response.data;
      const texts = content.flatMap(({ type, text }) => type === "text" && text !== undefined ? [text] : []);
      if (isError === true) {
        throw appRefusal(texts.join("\n"));
      }
      if (structuredContent != null) {
        return structuredContent;
      }
      const text = texts.join("\n");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AppGatewayError("invalid response");
      }
    } catch (error) {
      const normalized = error instanceof AppGatewayError ? error : new AppGatewayError("invalid response");
      const failure = authorized !== undefined && (normalized.kind === "invalid response" || (normalized.status ?? 0) >= 500)
        ? new AppGatewayError("write outcome unknown", normalized.status)
        : normalized;
      this.options.report?.(failure.message);
      throw failure;
    }
  }
}
