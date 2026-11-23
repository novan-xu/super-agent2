import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { initialWaiting } from "../live/waiting.js";
import { RepositoryTabs } from "./RepositoryTabs.js";

const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path): path is string => path !== undefined && existsSync(path));

it.skipIf(chrome === undefined)("shrinks tabs within the header and scrolls only the strip at its minimum", () => {
  const directory = mkdtempSync(join(process.env.SUPERAGENT2_ARTIFACTS_DIR ?? tmpdir(), "tabs-layout-"));
  const profiles = mkdtempSync(join(tmpdir(), "tabs-chrome-"));
  try {
    const css = ["prototype.css", "page.css"].map((name) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8")).join("\n");
    const repositories = Array.from({ length: 18 }, (_, index) => ({ repository: `org/repository-${index}`, account: "novan-xu" as const, chosen: false, pinned: true, pinnedOrder: index }));
    const tabs = renderToStaticMarkup(<RepositoryTabs repositories={repositories} tickets={[]} topics={[]} waiting={initialWaiting} selected="org/repository-0" select={() => undefined} pin={async () => true} order={async () => true} />);
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="app"><div class="app"><nav class="side">Super Agent</nav><div class="body"><header class="top top--workbench">${tabs}<div class="od-row"></div></header><main class="main is-fill"><div class="wb-layout"></div></main></div></div></div><script>
      const tabs = [...document.querySelectorAll('.wb-tab')];
      const header = document.querySelector('.top--workbench');
      const strip = document.querySelector('.wb-tabs-scroll');
      const result = { viewport: innerWidth, page: document.documentElement.scrollWidth, header: header.getBoundingClientRect().right, widths: tabs.map(tab => tab.getBoundingClientRect().width), stripClient: strip.clientWidth, stripScroll: strip.scrollWidth, add: document.querySelector('.wb-add').getBoundingClientRect().right, activeClose: getComputedStyle(document.querySelector('.is-active .wb-tab-close')).visibility, inactiveLabel: getComputedStyle(tabs[3].querySelector('.od-truncate')).display, background: getComputedStyle(header).backgroundColor, sidebar: getComputedStyle(document.querySelector('.side')).backgroundColor };
      document.body.appendChild(document.createElement('pre')).textContent = JSON.stringify(result);
    </script></body></html>`;
    const file = join(directory, "fixture.html");
    writeFileSync(file, html);
    const measure = (width: number, height: number) => {
      const result = spawnSync(chrome!, ["--headless", "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(profiles, `profile-${width}-${height}`)}`, `--window-size=${width},${height}`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout.match(/<pre>(.*?)<\/pre>/s)![1]!) as { viewport: number; page: number; header: number; widths: number[]; stripClient: number; stripScroll: number; add: number; activeClose: string; inactiveLabel: string; background: string; sidebar: string };
    };
    const narrow = measure(600, 900);
    const wide = measure(2560, 900);
    for (const result of [narrow, wide]) {
      expect(result.page).toBe(result.viewport);
      expect(result.header).toBeLessThanOrEqual(result.viewport);
      expect(result.add).toBeLessThanOrEqual(result.viewport);
      expect(Math.max(...result.widths) - Math.min(...result.widths)).toBeLessThan(1);
      expect(result.activeClose).toBe("visible");
      expect(result.background).toBe(result.sidebar);
    }
    expect(narrow.widths[0]).toBeLessThan(wide.widths[0]!);
    expect(narrow.inactiveLabel).toBe("none");
    expect(narrow.stripScroll).toBeGreaterThan(narrow.stripClient);
    expect(wide.stripScroll).toBe(wide.stripClient);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(profiles, { recursive: true, force: true }); }
});
