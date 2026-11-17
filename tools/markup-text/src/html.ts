import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { shownAttributes } from "./attributes.js";
import { type Finding, hasLetters, literalMessage, Positions, reasonOf, unparsable } from "./finding.js";

type Node = DefaultTreeAdapterTypes.Node;

const silentElements = new Set(["script", "style"]);

function childrenOf(node: Node): Node[] {
  const children: Node[] = "childNodes" in node ? [...node.childNodes] : [];
  if (node.nodeName === "template" && "content" in node) {
    children.push(...node.content.childNodes);
  }
  return children;
}

export function findHtmlText(text: string): Finding[] {
  const positions = new Positions(text);
  const findings: Finding[] = [];

  const visit = (node: Node): void => {
    if (node.nodeName === "#text" && "value" in node && hasLetters(node.value)) {
      const location = node.sourceCodeLocation;
      const start = location?.startOffset ?? 0;
      const raw = text.slice(start, location?.endOffset ?? start);
      const index = Math.max(raw.search(/\p{L}/u), 0);
      findings.push({ ...positions.at(start + index), message: literalMessage(node.value) });
    }
    if ("attrs" in node) {
      for (const attribute of node.attrs) {
        if (shownAttributes.has(attribute.name.toLowerCase()) && hasLetters(attribute.value)) {
          const location = node.sourceCodeLocation?.attrs?.[attribute.name];
          findings.push({ ...positions.at(location?.startOffset ?? 0), message: literalMessage(attribute.value) });
        }
      }
    }
    if ("tagName" in node && silentElements.has(node.tagName)) {
      return;
    }
    for (const child of childrenOf(node)) {
      visit(child);
    }
  };

  try {
    visit(parse(text, { sourceCodeLocationInfo: true }));
  } catch (error) {
    findings.push(unparsable(1, 1, reasonOf(error)));
  }
  return findings;
}
