import { Parser } from "yaml";
import { comment, Positions, type Finding } from "./finding.js";

function collect(value: unknown, offsets: number[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, offsets);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["type"] === "comment" && typeof record["offset"] === "number") {
      offsets.push(record["offset"]);
    }
    for (const child of Object.values(record)) {
      collect(child, offsets);
    }
  }
}

export function findYamlComments(text: string): Finding[] {
  const positions = new Positions(text);
  const offsets: number[] = [];
  for (const token of new Parser().parse(text)) {
    collect(token, offsets);
  }
  return [...new Set(offsets)]
    .sort((a, b) => a - b)
    .map((offset) => {
      const { line, column } = positions.at(offset);
      return comment(line, column);
    });
}
