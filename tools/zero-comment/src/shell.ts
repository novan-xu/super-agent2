import { parse } from "sh-syntax/sync";
import { comment, reasonOf, unparsable, type Finding } from "./finding.js";

interface CommentNode {
  type: "Comment";
  hash: { line: number; column: number };
}

function collect(value: unknown, found: CommentNode[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, found);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["type"] === "Comment") {
      found.push(record as unknown as CommentNode);
    }
    for (const child of Object.values(record)) {
      collect(child, found);
    }
  }
}

export function findShellComments(text: string): Finding[] {
  try {
    const found: CommentNode[] = [];
    collect(parse(text, { keepComments: true }), found);
    return found.map((node) => comment(node.hash.line, node.hash.column + 1));
  } catch (error) {
    const location = /^(?:[^:]*:)?(\d+):(\d+):/.exec(reasonOf(error));
    return [unparsable(Number(location?.[1] ?? 1), Number(location?.[2] ?? 1), reasonOf(error))];
  }
}
