import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { findCssComments } from "./css.js";
import { comment, embedded, Positions, type Finding } from "./finding.js";
import { findScriptComments } from "./javascript.js";
import { findJsonComments } from "./json.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const classicScriptTypes = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
  "text/x-javascript",
  "text/jsx",
]);

const jsonScriptTypes = new Set(["application/json", "importmap", "speculationrules"]);

type Embedded = "script" | "module" | "json" | "css" | undefined;

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

function scriptLanguage(element: Element): Embedded {
  const type = (attribute(element, "type") ?? "").trim().toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "module") {
    return "module";
  }
  if (classicScriptTypes.has(type)) {
    return "script";
  }
  if (jsonScriptTypes.has(type) || type.endsWith("+json")) {
    return "json";
  }
  return undefined;
}

function checkEmbedded(language: Embedded, text: string): Finding[] {
  switch (language) {
    case "script":
      return findScriptComments(text, { dialect: "js", sourceType: "script" });
    case "module":
      return findScriptComments(text, { dialect: "js", sourceType: "module" });
    case "json":
      return findJsonComments(text);
    case "css":
      return findCssComments(text);
    case undefined:
      return [];
  }
}

function childrenOf(node: Node): Node[] {
  const children: Node[] = "childNodes" in node ? [...node.childNodes] : [];
  if (node.nodeName === "template" && "content" in node) {
    children.push(node.content);
  }
  return children;
}

function attributeValueStart(source: string, startOffset: number, endOffset: number, positions: Positions) {
  const raw = source.slice(startOffset, endOffset);
  const match = /^[^=]*=\s*["']?/.exec(raw);
  return positions.at(startOffset + (match ? match[0].length : raw.length));
}

function checkElement(element: Element, source: string, positions: Positions): Finding[] {
  const findings: Finding[] = [];
  const location = element.sourceCodeLocation;
  for (const item of element.attrs) {
    const name = item.name.toLowerCase();
    const language: Embedded = name === "style" ? "css" : name.startsWith("on") ? "script" : undefined;
    const attributeLocation = location?.attrs?.[item.name];
    if (language && attributeLocation) {
      const start = attributeValueStart(source, attributeLocation.startOffset, attributeLocation.endOffset, positions);
      findings.push(...embedded(checkEmbedded(language, item.value), start.line, start.column));
    }
  }
  const language = element.tagName === "script" ? scriptLanguage(element) : element.tagName === "style" ? "css" : undefined;
  if (language) {
    for (const child of element.childNodes) {
      if (child.nodeName === "#text" && "value" in child && child.sourceCodeLocation) {
        const start = child.sourceCodeLocation;
        findings.push(...embedded(checkEmbedded(language, child.value), start.startLine, start.startCol));
      }
    }
  }
  return findings;
}

function walk(node: Node, source: string, positions: Positions, findings: Finding[]): void {
  if (node.nodeName === "#comment" && "data" in node && node.sourceCodeLocation) {
    findings.push(comment(node.sourceCodeLocation.startLine, node.sourceCodeLocation.startCol));
  }
  if ("tagName" in node) {
    findings.push(...checkElement(node, source, positions));
  }
  for (const child of childrenOf(node)) {
    walk(child, source, positions, findings);
  }
}

export function findHtmlComments(text: string, options: { fragment?: boolean } = {}): Finding[] {
  const root = options.fragment
    ? parseFragment(text, { sourceCodeLocationInfo: true })
    : parse(text, { sourceCodeLocationInfo: true });
  const findings: Finding[] = [];
  walk(root, text, new Positions(text), findings);
  return findings;
}
