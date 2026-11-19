import { parse, type ParserOptions } from "@babel/parser";
import { comment, reasonOf, unparsable, type Finding } from "./finding.js";

export type ScriptDialect = "js" | "jsx" | "ts" | "tsx" | "dts";

export interface ScriptOptions {
  dialect: ScriptDialect;
  sourceType?: "script" | "commonjs" | "module" | "unambiguous";
}

function pluginsFor(dialect: ScriptDialect): NonNullable<ParserOptions["plugins"]> {
  switch (dialect) {
    case "js":
    case "jsx":
      return ["jsx"];
    case "ts":
      return ["typescript"];
    case "tsx":
      return ["typescript", "jsx"];
    case "dts":
      return [["typescript", { dts: true }]];
  }
}

export function findScriptComments(text: string, options: ScriptOptions): Finding[] {
  const findings: Finding[] = [];
  if (text.startsWith("#!")) {
    findings.push(comment(1, 1));
  }
  try {
    const sourceType = options.sourceType ?? "unambiguous";
    const file = parse(text, {
      sourceType,
      plugins: pluginsFor(options.dialect),
      errorRecovery: true,
      attachComment: false,
      ...(sourceType === "commonjs" ? {} : { allowReturnOutsideFunction: true }),
    });
    for (const node of file.comments ?? []) {
      const start = node.loc?.start;
      if (start) {
        findings.push(comment(start.line, start.column + 1));
      }
    }
  } catch (error) {
    const location = (error as { loc?: { line: number; column: number } }).loc;
    findings.push(unparsable(location?.line ?? 1, (location?.column ?? 0) + 1, reasonOf(error)));
  }
  return findings;
}
