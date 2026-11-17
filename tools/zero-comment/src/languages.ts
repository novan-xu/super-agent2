import { findCssComments } from "./css.js";
import { findDockerfileComments } from "./dockerfile.js";
import type { Finding } from "./finding.js";
import { findHtmlComments } from "./html.js";
import { findScriptComments } from "./javascript.js";
import { findJsonComments } from "./json.js";
import { findMarkdownComments } from "./markdown.js";
import { findPowerShellComments } from "./powershell.js";
import { findShellComments } from "./shell.js";
import { findYamlComments } from "./yaml.js";

export type Language =
  | "typescript"
  | "tsx"
  | "declaration"
  | "javascript"
  | "module"
  | "commonjs"
  | "css"
  | "html"
  | "markdown"
  | "yaml"
  | "shell"
  | "powershell"
  | "dockerfile"
  | "json";

const byExtension: Record<string, Language> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "module",
  cjs: "commonjs",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  json: "json",
  jsonc: "json",
  json5: "json",
  dockerfile: "dockerfile",
};

export function languageOf(path: string): Language | undefined {
  const name = path.split(/[\/]/).pop() ?? "";
  const lower = name.toLowerCase();
  if (/\.d\.[mc]?ts$/.test(lower)) {
    return "declaration";
  }
  if (/^(dockerfile|containerfile)(\..+)?$/.test(lower)) {
    return "dockerfile";
  }
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? byExtension[lower.slice(dot + 1)] : undefined;
}

export function findComments(language: Language, text: string): Finding[] {
  switch (language) {
    case "typescript":
      return findScriptComments(text, { dialect: "ts", sourceType: "module" });
    case "tsx":
      return findScriptComments(text, { dialect: "tsx", sourceType: "module" });
    case "declaration":
      return findScriptComments(text, { dialect: "dts", sourceType: "module" });
    case "javascript":
      return findScriptComments(text, { dialect: "jsx", sourceType: "unambiguous" });
    case "module":
      return findScriptComments(text, { dialect: "jsx", sourceType: "module" });
    case "commonjs":
      return findScriptComments(text, { dialect: "jsx", sourceType: "commonjs" });
    case "css":
      return findCssComments(text);
    case "html":
      return findHtmlComments(text);
    case "markdown":
      return findMarkdownComments(text);
    case "yaml":
      return findYamlComments(text);
    case "shell":
      return findShellComments(text);
    case "powershell":
      return findPowerShellComments(text);
    case "dockerfile":
      return findDockerfileComments(text);
    case "json":
      return findJsonComments(text);
  }
}
