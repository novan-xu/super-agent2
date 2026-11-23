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
    targets: { ...workbench, ...canvas },
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

function checkLayout(page: Page, width: Width, targets: LayoutTargets): Promise<string[]> {
  return page.evaluate(layoutProblems, { width: viewports[width].width, targets });
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
    const targets = { [phone ? "bottom navigation" : "sidebar"]: phone ? ".tabbar" : ".side", ...view.targets, ...view[width] };
    const issues = mode.kind === "check" ? await checkLayout(page, width, targets) : [];
    if (view.after !== undefined && issues.length === 0) {
      await view.after(page, fixture);
      if (mode.kind === "check") issues.push(...await checkLayout(page, width, {
        "HTML preview": ".fv-html",
        "preview filename": ".fv-header strong",
        "preview actions": ".fv-header button, .fv-header a",
      }));
    }
    if (mode.kind === "check") {
      if (issues.length > 0) throw new Error(issues.join("\n"));
      process.stdout.write(`Layout passed for ${name} at ${width} (${viewports[width].width}px)\n`);
    } else {
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
