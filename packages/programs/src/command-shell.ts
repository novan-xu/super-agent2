import { win32 } from "node:path";

export function windowsPowerShell(environment: Readonly<Record<string, string | undefined>>): string {
  const root = Object.entries(environment).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1] || "C:\\Windows";
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function shellInvocation(command: string, powerShell?: string): { file: string; args: string[]; shell: boolean } {
  if (powerShell === undefined) return { file: command, args: [], shell: true };
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
    command,
    "if (!$?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }",
  ].join("\n");
  return { file: powerShell, args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], shell: false };
}
