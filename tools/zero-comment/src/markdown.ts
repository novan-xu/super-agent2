import { fromMarkdown } from "mdast-util-from-markdown";
import { embedded, type Finding } from "./finding.js";
import { findHtmlComments } from "./html.js";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { line: number; column: number } };
}

function walk(node: MarkdownNode, findings: Finding[]): void {
  if (node.type === "html" && typeof node.value === "string" && node.position) {
    const { line, column } = node.position.start;
    findings.push(...embedded(findHtmlComments(node.value, { fragment: true }), line, column));
  }
  for (const child of node.children ?? []) {
    walk(child, findings);
  }
}

export function findMarkdownComments(text: string): Finding[] {
  const findings: Finding[] = [];
  walk(fromMarkdown(text) as MarkdownNode, findings);
  return findings;
}
