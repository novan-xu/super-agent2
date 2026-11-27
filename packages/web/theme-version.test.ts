import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { versionThemeScript } from "./theme-version.js";

it("binds the bootstrap URL to the script content for each deployment", () => {
  const html = '<script src="/theme.js"></script>';
  const script = Buffer.from("updated theme");
  const hash = createHash("sha256").update(script).digest("hex");
  expect(versionThemeScript(html, script)).toBe(`<script src="/theme.js?v=${hash}"></script>`);
  expect(versionThemeScript(html, Buffer.from("previous theme"))).not.toBe(versionThemeScript(html, script));
  expect(() => versionThemeScript("<head></head>", script)).toThrow();
});
