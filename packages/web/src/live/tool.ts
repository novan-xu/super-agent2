const summaryLength = 160;

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return [...line].length > summaryLength ? `${[...line].slice(0, summaryLength - 1).join("")}…` : line;
}

function commandOf(input: string): string | undefined {
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ["command", "cmd", "query", "path", "file_path", "url", "pattern"]) {
        const found = record[key];
        if (typeof found === "string" && found.trim() !== "") {
          return found;
        }
        if (Array.isArray(found) && found.every((part) => typeof part === "string") && found.length > 0) {
          return found.join(" ");
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function toolName(name: string): string {
  const parts = name.split("__");
  return parts.length >= 3 && parts[0] === "mcp" ? parts.slice(2).join("__") : name;
}

export function toolSummary(input: string): string {
  return firstLine(commandOf(input) ?? input);
}
