import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface Point { line: number; offset?: number }
interface Node { type: string; children?: Node[]; position?: { start: Point; end: Point } }
export interface Finding { line: number; message: string }

const abbreviations = new Set(["e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "ms.", "dr.", "st.", "fig.", "no."]);

function hasMultipleSentences(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!c || !".!?。！？".includes(c)) continue;
    if (c === "." && (line[i - 1] === "." || line[i + 1] === ".")) continue;
    let end = i + 1;
    while (end < line.length && /["'”’\])]/.test(line[end]!)) end++;
    if (end >= line.length) continue;
    if (!"。！？".includes(c) && !/\s/.test(line[end]!)) continue;
    if (!line.slice(end).trim()) continue;
    const word = line.slice(0, i + 1).match(/(?:[A-Za-z]\.){2,}$|[A-Za-z]+\.$/)?.[0]?.toLowerCase();
    if (word && abbreviations.has(word)) continue;
    return true;
  }
  return false;
}

export function findSentenceLines(source: string): Finding[] {
  const frontMatter = source.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)?.[0];
  const text = frontMatter ? frontMatter.replace(/[^\r\n]/g, " ") + source.slice(frontMatter.length) : source;
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
  const findings: Finding[] = [];
  function inspect(node: Node): void {
    if (node.type !== "paragraph" || !node.position) {
      if (!["table", "html", "code"].includes(node.type)) for (const child of node.children ?? []) inspect(child);
      return;
    }
    const start = node.position.start.offset!;
    const end = node.position.end.offset!;
    const raw = text.slice(start, end);
    const projected: string[] = raw.split("").map((c) => c === "\n" || c === "\r" ? c : " ");
    const inlineNewlines = new Set<number>();
    function project(child: Node): void {
      if (!child.position) return;
      const a = child.position.start.offset! - start;
      const b = child.position.end.offset! - start;
      if (child.type === "text") {
        for (let i = a; i < b; i++) projected[i] = raw[i]!;
      } else if (child.type === "inlineCode" || child.type === "image" || child.type === "imageReference") {
        for (let i = a; i < b; i++) {
          if (raw[i] === "\n") inlineNewlines.add(i);
          else if (raw[i] !== "\r") projected[i] = "x";
        }
      } else if (child.type !== "html") {
        for (const nested of child.children ?? []) project(nested);
      }
    }
    for (const child of node.children ?? []) project(child);
    const lines: { line: string; number: number }[] = [];
    let number = node.position.start.line;
    let current = { line: "", number };
    for (let i = 0; i < projected.length; i++) {
      const char = projected[i]!;
      if (char === "\r" && projected[i + 1] === "\n") continue;
      if (char === "\n" || char === "\r") {
        number++;
        if (inlineNewlines.has(i)) current.line += " ";
        else { lines.push(current); current = { line: "", number }; }
      } else current.line += char;
    }
    lines.push(current);
    const prose = lines.map(({ line, number }) => ({ line: line.trim(), number })).filter(({ line }) => line.length > 0);
    for (let i = 0; i < prose.length; i++) {
      const current = prose[i]!;
      if (hasMultipleSentences(current.line)) findings.push({ line: current.number, message: "multiple sentences on one line" });
      if (i < prose.length - 1 && !/[.!?。！？:]["'”’\])]*$/.test(current.line)) {
        findings.push({ line: current.number, message: "sentence wraps onto the next line" });
      }
    }
  }
  inspect(tree);
  return findings;
}
