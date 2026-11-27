import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { manifestPath, pageAssetsPath, pageIconsPath, pageRoute, serviceWorkerPath, themeScriptPath } from "@super-agent2/protocol";
import { webManifest } from "./manifest.js";

export interface PageFile {
  readonly body: Buffer;
  readonly type: string;
  readonly immutable: boolean;
}

export type PageFiles = (path: string) => Promise<PageFile | undefined>;

const assetName = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const types: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
};

const iconExtensions: ReadonlySet<string> = new Set(["png", "svg", "ico", "webp"]);

export const pageSecurityHeaders: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

async function readOrNothing(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

export function pageFiles(directory: string): PageFiles {
  return async (path) => {
    if (pageRoute(path) !== undefined) {
      const body = await readOrNothing(join(directory, "index.html"));
      return body === undefined ? undefined : { body, type: "text/html; charset=utf-8", immutable: false };
    }
    if (path === manifestPath) {
      return { body: Buffer.from(await webManifest(join(directory, "icons"))), type: "application/manifest+json; charset=utf-8", immutable: false };
    }
    if (path === serviceWorkerPath || path === themeScriptPath) {
      const body = await readOrNothing(join(directory, path === serviceWorkerPath ? "sw.js" : "theme.js"));
      return body === undefined ? undefined : { body, type: types["js"] ?? "text/javascript", immutable: false };
    }
    const pdfAsset = /^\/pdfjs\/(cmaps|standard_fonts)\/([A-Za-z0-9._-]+)$/.exec(path);
    if (pdfAsset !== null && pdfAsset[1] !== undefined && pdfAsset[2] !== undefined) {
      const body = await readOrNothing(join(directory, "pdfjs", pdfAsset[1], pdfAsset[2]));
      return body === undefined ? undefined : { body, type: "application/octet-stream", immutable: true };
    }
    const folder = path.startsWith(pageAssetsPath) ? "assets" : path.startsWith(pageIconsPath) ? "icons" : undefined;
    if (folder === undefined) {
      return undefined;
    }
    const name = path.slice(folder === "assets" ? pageAssetsPath.length : pageIconsPath.length);
    const extension = name.split(".").pop() ?? "";
    const type = types[extension];
    const versionedIcon = folder === "icons" ? /^(.+)\.([a-f0-9]{64})\.(png|svg|ico|webp)$/.exec(name) : null;
    const sourceName = versionedIcon?.[1] === undefined ? name : `${versionedIcon[1]}.${versionedIcon[3]}`;
    if (!assetName.test(name) || type === undefined || (folder === "icons" && !iconExtensions.has(extension))) {
      return undefined;
    }
    const body = await readOrNothing(join(directory, folder, sourceName));
    if (body === undefined || (versionedIcon !== null && createHash("sha256").update(body).digest("hex") !== versionedIcon[2])) return undefined;
    return { body, type, immutable: folder === "assets" || versionedIcon !== null };
  };
}
