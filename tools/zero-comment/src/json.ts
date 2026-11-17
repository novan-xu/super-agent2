import { visit } from "jsonc-parser";
import { comment, type Finding } from "./finding.js";

export function findJsonComments(text: string): Finding[] {
  const findings: Finding[] = [];
  visit(text, {
    onComment: (_offset, _length, startLine, startCharacter) => {
      findings.push(comment(startLine + 1, startCharacter + 1));
    },
  });
  return findings;
}
