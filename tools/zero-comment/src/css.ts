import { tokenize, TokenType } from "@csstools/css-tokenizer";
import { comment, Positions, type Finding } from "./finding.js";

export function findCssComments(text: string): Finding[] {
  const positions = new Positions(text);
  return tokenize({ css: text })
    .filter((token) => token[0] === TokenType.Comment)
    .map((token) => {
      const { line, column } = positions.at(token[2]);
      return comment(line, column);
    });
}
