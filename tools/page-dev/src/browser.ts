import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pagePath, type PageRoute } from "@super-agent2/protocol";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { chromiumExecutable } from "./chromium.js";
import { layoutProblems, type LayoutTargets } from "./layout-check.js";
import type { LayoutFixture } from "./layout-fixture.js";

const viewports = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;
type Width = keyof typeof viewports;

interface View {
  readonly route: PageRoute | ((fixture: LayoutFixture) => PageRoute);
  readonly ready: string | ((width: Width) => string);
  readonly targets: LayoutTargets;
  readonly phone?: LayoutTargets;
  readonly desktop?: LayoutTargets;
  prepare?(page: Page, width: Width, fixture: LayoutFixture): Promise<void>;
  after?(page: Page, fixture: LayoutFixture): Promise<void>;
}

const composer = {
  composer: ".composer",
  "message field": ".composer textarea",
  "send button": ".composer button[type=submit]",
};
const conversation = { ...composer, "conversation tabs": ".conv-tabs", "conversation links": ".conv-tabs a", "owner bubbles": ".chat-message.msg--me .msg-text", "brain bubbles": ".chat-message.msg--brain .msg-text", "wide image": ".att-image img", "code block": ".msg-text pre", "table": ".msg-text table" };
const workbench = { "repository tabs": ".wb-tabs", "repository tab strip": ".wb-tabs-scroll", "open repository": ".wb-add" };
const canvas = { "workbench canvas": ".wb-canvas", "workbench toolbar": ".wb-toolbar", "workbench actions": ".wb-toolbar button", "ticket cards": ".wb-card" };
const settingsMenu = { "settings menu": ".set-nav", "settings links": ".set-nav .nav-btn" };

async function loadImages(images: Locator): Promise<void> {
  await images.evaluateAll((elements) => Promise.all(elements.map(async (element) => {
    if (!(element instanceof HTMLImageElement)) return;
    element.loading = "eager";
    await element.decode();
  })));
}

async function checkPhoneRepositoryTabs(page: Page): Promise<void> {
  const buttons = page.locator(".wb-tab-select");
  if (await buttons.count() < 7) throw new Error("Repository tab fixture needs at least five pinned repositories");
  for (const index of [6, 1, 0]) {
    await buttons.nth(index).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction((selected) => document.querySelectorAll('.wb-tab-select')[selected]?.getAttribute('aria-pressed') === 'true', index);
    const problem = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>(".wb-tabs-scroll")!;
      const active = strip.querySelector<HTMLElement>(".wb-tab.is-active")!;
      const label = active.querySelector<HTMLElement>(".od-truncate")!;
      const bounds = strip.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      if (tab.left < bounds.left - 1 || tab.right > bounds.right + 1) return "Active repository tab is outside the strip";
      if (label.clientWidth < 80 || getComputedStyle(label).display === "none") return "Active repository label is too narrow";
      if ([...strip.querySelectorAll(".wb-tab")].some((item) => item.querySelector(".dot") === null)) return "Repository tab is missing its state dot";
      return "";
    });
    if (problem !== "") throw new Error(problem);
  }
}

async function checkCanvasColumns(page: Page, width: Width): Promise<void> {
  const problem = await page.evaluate((phone) => {
    const grids = [...document.querySelectorAll<HTMLElement>(".wb-grid")];
    const single = grids.find((grid) => grid.children.length === 1);
    const multiple = grids.find((grid) => grid.children.length > 1);
    if (single === undefined || multiple === undefined) return "Canvas fixture needs single and multiple chain sections";
    const one = single.firstElementChild!.getBoundingClientRect();
    const first = multiple.children[0]!.getBoundingClientRect();
    const second = multiple.children[1]!.getBoundingClientRect();
    if (Math.abs(one.width - first.width) > 1 || Math.abs(one.left - first.left) > 1) return "Canvas columns are not aligned across sections";
    if (phone ? Math.abs(first.left - second.left) > 1 : second.left <= first.right) return "Canvas chains do not flow in the expected columns";
    return "";
  }, width === "phone");
  if (problem !== "") throw new Error(problem);
}

async function checkCanvasGraphs(page: Page, graphs: LayoutFixture["graphs"]): Promise<void> {
  const problem = await page.evaluate((chains) => {
    const close = (a: number, b: number) => Math.abs(a - b) < 1;
    for (const [index, ids] of chains.entries()) {
      const chain = document.querySelector(`.wb-slot[data-ticket="${ids[0]}"]`)?.closest(".wb-chain");
      const slots = Array.from(chain?.querySelectorAll<HTMLElement>(".wb-slot") ?? []);
      if (slots.map((slot) => Number(slot.dataset.ticket)).join() !== ids.join()) return "Graph rows do not share one chain in dependency order";
      const cards = slots.map((slot) => slot.querySelector(".wb-card")!.getBoundingClientRect());
      const gutters = slots.map((slot) => slot.querySelector(".wb-gutter")?.getBoundingClientRect());
      const dots = slots.map((slot) => slot.querySelector(".wb-rail-dot")?.getBoundingClientRect().left);
      if (cards.some((card) => !close(card.left, cards[0]!.left) || !close(card.right, cards[0]!.right))) return "Graph cards are not aligned";
      if (gutters.some((gutter, row) => gutter === undefined || !close(gutter.right, cards[row]!.left)
        || (row < slots.length - 1 && !close(gutter.bottom, cards[row + 1]!.top)))) return "Graph gutters do not reach the next row or align with the cards";
      if (dots.includes(undefined) || new Set(dots).size !== 2) return "Graph dots do not occupy two lanes";
      if (chain?.querySelectorAll(".wb-lane-clearance").length !== (index === 0 ? 2 : 1)) return "Graph is missing a fork or merge arc";
    }
    return "";
  }, graphs);
  if (problem !== "") throw new Error(problem);
}

const views = {
  code: {
    route: { view: "conversations", conversation: null, scope: { kind: "code" } },
    ready: ".msg-text table",
    targets: conversation,
    phone: { "topic list button": ".conv-pick" },
    desktop: { "repository selector": ".conv-repository", "topic list links": ".rail .rail-item" },
  },
  daily: {
    route: { view: "conversations", conversation: null, scope: { kind: "daily" } },
    ready: ".msg-text table",
    targets: conversation,
  },
  "workbench-canvas": {
    route: { view: "workbench" },
    ready: ".wb-card",
    targets: { ...workbench, ...canvas, "graph gutters": ".wb-gutter" },
    phone: { "workbench pane tabs": ".wb-mobile-tabs button" },
    desktop: composer,
    prepare: async (page, width) => {
      await page.locator(".wb-tab-close").first().waitFor({ state: "attached" });
      if (width === "desktop") await page.locator(".wb-panel .msg-text table").first().waitFor();
    },
  },
  "workbench-conversation": {
    route: { view: "workbench" },
    ready: ".wb-panel .msg-text table",
    targets: { ...workbench, ...composer, "workbench conversation": ".wb-panel", "code block": ".wb-panel .msg-text pre", table: ".wb-panel .msg-text table" },
    phone: { "workbench pane tabs": ".wb-mobile-tabs button" },
    desktop: canvas,
    prepare: async (page, width) => {
      await page.locator(".wb-tab-close").first().waitFor({ state: "attached" });
      if (width === "phone") await page.locator(".wb-mobile-tabs button").nth(1).click();
    },
  },
  ticket: {
    route: ({ ticket }) => ({ view: "ticket", ticket }),
    ready: ".timeline",
    targets: { "ticket title": ".dhead h2", "ticket timeline": ".timeline", "back link": ".dhead .back", "ticket actions": ".panel-actions button", "timeline navigation": ".ticket-jump button" },
    phone: { "ticket panel toggle": ".panel-toggle" },
  },
  transfer: {
    route: { view: "transfer" },
    ready: ".msg-files .chip",
    targets: { ...composer, "conversation tabs": ".conv-tabs", "transfer attachment": ".msg-files .chip" },
    phone: { "recent files button": ".conv-pick" },
    desktop: { "recent file links": ".rail .rail-item" },
    after: async (page, { previewName }) => {
      await page.locator(".stream").getByText(previewName, { exact: true }).click();
      const preview = page.frameLocator(".fv-html");
      await preview.locator("h1").waitFor();
      await loadImages(preview.locator("img"));
    },
  },
  settings: {
    route: { view: "settings" },
    ready: (width) => width === "phone" ? ".set-nav" : ".add-machine",
    targets: settingsMenu,
    desktop: { "add machine": ".add-machine button[type=submit]" },
  },
  machines: {
    route: { view: "settings", section: "machines" },
    ready: ".mcard",
    targets: { "machine load indicator": ".mcard .chip--warn", "load thresholds": ".load-fields input" },
    phone: { "settings back link": ".set-back" },
    desktop: settingsMenu,
  },
  models: {
    route: { view: "settings", section: "models" },
    ready: ".set-body select",
    targets: { "model selectors": ".set-body select", "model actions": ".srow-ctl button" },
    phone: { "settings back link": ".set-back" },
    desktop: settingsMenu,
  },
  memory: {
    route: { view: "memory" },
    ready: ".mrow-text",
    targets: { "memory text": ".mrow-text", "memory actions": ".mrow-actions button", "add memory": ".top button" },
  },
  schedules: {
    route: { view: "schedules" },
    ready: ".schedule-card",
    targets: { "schedule canvas": ".schedules", "schedule proposals": ".schedule-card--proposal", "schedule cards": ".schedule-card:not(.schedule-card--proposal)", "schedule actions": ".schedule-actions button" },
    phone: { "pending count": ".tab[href='/schedules'] .tab-badge" },
    desktop: { "pending count": ".nav-btn[href='/schedules'] .count" },
  },
  history: {
    route: { view: "settings", section: "history" },
    ready: ".lrow",
    targets: { "history search": "input[type=search]", "history rows": ".lrow" },
    phone: { "settings back link": ".set-back" },
    desktop: settingsMenu,
  },
} as const satisfies Record<string, View>;

type ViewName = keyof typeof views;
type Mode = { readonly kind: "check" } | { readonly kind: "screenshot"; readonly out: string; readonly theme: "light" | "dark" };

async function checkMobileShell(browser: Browser, url: string, fixture: LayoutFixture): Promise<void> {
  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true });
    try {
      await page.goto(url + pagePath({ view: "ticket", ticket: fixture.ticket }));
      await page.locator(".timeline").waitFor();
      const result = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>(".main")!;
        const target = document.querySelector<HTMLElement>(".timeline")!;
        target.scrollIntoView({ block: "end" });
        window.scrollTo(0, 300);
        return { height: document.scrollingElement!.scrollHeight, viewport: innerHeight, scroll: scrollY, bottom: document.querySelector(".tabbar")!.getBoundingClientRect().bottom, top: document.querySelector(".top")!.getBoundingClientRect().top, pane: pane.clientHeight };
      });
      if (result.height !== result.viewport || result.scroll !== 0 || Math.abs(result.bottom - result.viewport) > 1 || result.top !== 0 || result.pane === 0) throw new Error(`Mobile shell escaped viewport at ${viewport.width}px: ${JSON.stringify(result)}`);
    } finally {
      await page.close();
    }
  }
}

function checkLayout(page: Page, width: Width, targets: LayoutTargets): Promise<string[]> {
  return page.evaluate(layoutProblems, { width: viewports[width].width, targets });
}

async function checkLoadSettings(page: Page): Promise<void> {
  const form = page.locator(".load-settings");
  const cpu = form.locator('input[type="number"]').first();
  const save = form.locator('button[type="submit"]');
  await cpu.fill("49");
  if (await save.isEnabled()) throw new Error("The load threshold form allows a pause threshold below its resume threshold");
  await cpu.fill("75");
  const [response] = await Promise.all([
    page.waitForResponse((result) => result.url().endsWith("/api/settings/machine-load") && result.request().method() === "PUT", { timeout: 5000 }),
    save.click({ timeout: 5000 }),
  ]);
  if (!response.ok()) throw new Error(`Saving load thresholds returned HTTP ${response.status()}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await cpu.waitFor({ timeout: 5000 });
  if (await cpu.inputValue() !== "75") throw new Error("The saved load threshold was lost on reload");
}

async function visit(browser: Browser, url: string, fixture: LayoutFixture, name: ViewName, width: Width, mode: Mode): Promise<void> {
  const phone = width === "phone";
  const page = await browser.newPage({
    viewport: viewports[width], colorScheme: mode.kind === "screenshot" ? mode.theme : "light", reducedMotion: "reduce", locale: "zh-CN", timezoneId: "UTC",
    isMobile: phone, hasTouch: phone, deviceScaleFactor: 1, serviceWorkers: "block",
  });
  page.setDefaultTimeout(0);
  const pageError = new Promise<never>((_, reject) => {
    page.on("pageerror", reject);
    page.on("crash", () => reject(new Error("Chromium page crashed")));
  });
  const openView = async () => {
    const view: View = views[name];
    const route = typeof view.route === "function" ? view.route(fixture) : view.route;
    const response = await page.goto(url + pagePath(route), { waitUntil: "domcontentloaded" });
    if (response?.ok() !== true) throw new Error(`Could not load ${pagePath(route)} (HTTP ${response?.status() ?? "unknown"})`);
    await view.prepare?.(page, width, fixture);
    const ready = typeof view.ready === "function" ? view.ready(width) : view.ready;
    await page.locator(ready).first().waitFor();
    await loadImages(page.locator(".att-image img"));
    await page.evaluate(async () => { await document.fonts.ready; });
    if (mode.kind === "check" && name === "workbench-canvas") {
      await checkCanvasColumns(page, width);
      await checkCanvasGraphs(page, fixture.graphs);
      if (phone) await checkPhoneRepositoryTabs(page);
    }
    if (name === "schedules" && (mode.kind === "check" || await page.locator(".schedule-card--proposal").count() > 0)) {
      await page.locator(phone ? ".tab[href='/schedules'] .tab-badge" : ".nav-btn[href='/schedules'] .count").waitFor({ timeout: 5000 });
    }
    const targets = { [phone ? "bottom navigation" : "sidebar"]: phone ? ".tabbar" : ".side", ...view.targets, ...view[width] };
    const issues = mode.kind === "check" ? await checkLayout(page, width, targets) : [];
    if (mode.kind === "check" && name === "machines" && width === "desktop" && issues.length === 0) await checkLoadSettings(page);
    if (mode.kind === "check" && name === "schedules" && issues.length === 0) {
      const proposal = page.locator(".schedule-card--proposal");
      await proposal.locator("summary").click();
      await proposal.getByRole("button", { name: "修改", exact: true }).click();
      issues.push(...await checkLayout(page, width, { "proposal changes": ".schedule-changes dd", "proposal editor": ".schedule-card--proposal .schedule-editor", "editor fields": ".schedule-editor .field" }));
    }
    if (view.after !== undefined && issues.length === 0) {
      await view.after(page, fixture);
      if (mode.kind === "check") issues.push(...await checkLayout(page, width, {
        "HTML preview": ".fv-html",
        "preview filename": ".fv-header strong",
        "preview actions": ".fv-header button, .fv-header a",
      }));
    }
    if (name === "workbench-canvas" && issues.length === 0) {
      await page.locator(`.wb-slot[data-ticket="${fixture.startCard}"] .wb-card--pending`).click();
      const dialog = page.locator(".wb-dialog[open]");
      await dialog.locator(".wcard-where").waitFor();
      if (mode.kind === "check") {
        const options = await dialog.locator("select option:checked").allTextContents();
        if (!options.includes("指定 mac-mini") || !options.includes("指定 Claude Code")) {
          issues.push("Start card is missing the pinned machine or engine label");
        }
        issues.push(...await checkLayout(page, width, {
          "start card": ".wb-dialog[open]",
          "start choices": ".wb-dialog select",
          "start button": ".wb-dialog .card-actions button",
        }));
      }
    }
    if (mode.kind === "check") {
      if (issues.length > 0) throw new Error(issues.join("\n"));
      process.stdout.write(`Layout passed for ${name} at ${width} (${viewports[width].width}px)\n`);
    } else {
      if (name === "ticket" && phone) await page.locator(".panel-toggle").click();
      if (name === "machines" && phone) await page.locator(".mcard").first().evaluate((card) => card.scrollIntoView({ block: "start" }));
      if (name === "daily" || name === "code" || name === "workbench-conversation") {
        const chain = page.locator(".conversation-chains").first();
        await chain.waitFor();
        await chain.evaluate((card) => card.scrollIntoView({ block: "end" }));
      }
      const file = join(mode.out, `${name}-${width}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      process.stdout.write(`Saved ${file}\n`);
    }
  };
  try {
    await Promise.race([openView(), pageError]);
  } catch (error) {
    throw new Error(`${name} at ${width} (${viewports[width].width}px)\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.context().close();
  }
}

async function run(names: readonly ViewName[], widths: readonly Width[], mode: Mode, pageDir?: string): Promise<void> {
  const executablePath = chromiumExecutable();
  const scratch = resolve(process.env.SUPERAGENT2_ARTIFACTS_DIR || tmpdir());
  await mkdir(scratch, { recursive: true });
  const data = await mkdtemp(join(scratch, "page-layout-"));
  const child = fork(fileURLToPath(new URL("cli.js", import.meta.url)), [
    "--port", "0", "--data", data, "--brain", "none", "--push", "none", "--layout-fixture",
    ...(pageDir === undefined ? [] : ["--page-dir", resolve(pageDir)]),
  ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "exit");
  const stopped = exited.then(([code, signal]) => { throw new Error(`Page harness exited (${signal ?? code})`); });
  const ready = once(child, "message").then(([message]) => message as { url: string; fixture: LayoutFixture });
  let browser: Browser | undefined;
  try {
    const { url, fixture } = await Promise.race([ready, stopped]);
    browser = await chromium.launch({ executablePath, timeout: 0 });
    if (mode.kind === "check") await checkMobileShell(browser, url, fixture);
    const failures: string[] = [];
    for (const name of names) {
      for (const width of widths) {
        if (mode.kind === "check") process.stdout.write(`Checking ${name} at ${width} (${viewports[width].width}px)\n`);
        try {
          await Promise.race([visit(browser, url, fixture, name, width, mode), stopped]);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length > 0) throw new Error(failures.join("\n\n"));
  } finally {
    try {
      await browser?.close();
    } finally {
      if (child.connected) child.disconnect();
      await exited.catch(() => undefined);
      await rm(data, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { view: { type: "string" }, width: { type: "string" }, out: { type: "string" }, theme: { type: "string" }, "page-dir": { type: "string" }, help: { type: "boolean" } },
});
const names = Object.keys(views) as ViewName[];
const widths = Object.keys(viewports) as Width[];
const usage = [
  "pnpm layout [--page-dir <built page dir>]",
  `pnpm screenshot --view <${names.join("|")}> [--width phone|desktop] [--out <dir>] [--theme light|dark] [--page-dir <built page dir>]`,
].join("\n");
const [command] = positionals;
if (values.help) {
  process.stdout.write(`${usage}\n`);
} else if (command === "check" && positionals.length === 1 && Object.keys(values).every((option) => option === "page-dir")) {
  await run(names, widths, { kind: "check" }, values["page-dir"]);
} else if (command === "screenshot" && positionals.length === 1 && names.includes(values.view as ViewName) && (values.width === undefined || widths.includes(values.width as Width)) && (values.theme === undefined || values.theme === "light" || values.theme === "dark")) {
  const out = resolve(values.out || process.env.SUPERAGENT2_ARTIFACTS_DIR || ".");
  await mkdir(out, { recursive: true });
  await run([values.view as ViewName], values.width === undefined ? widths : [values.width as Width], { kind: "screenshot", out, theme: values.theme === "dark" ? "dark" : "light" }, values["page-dir"]);
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
}
