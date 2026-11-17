import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRecord, OutputChunk } from "@super-agent2/protocol";
import type { CommandService } from "../commands.js";
import type { CredentialSource } from "../credentials.js";
import { type Job, localTarget, type Target } from "../targets.js";

export const testTokens = {
  "novan-xu": "test-token-for-novan-xu",
  "nuofan-island": "test-token-for-nuofan-island",
} as const;

export const testCredentials: CredentialSource = (account) => ({
  ok: true,
  credentials: { GH_TOKEN: testTokens[account], GITHUB_TOKEN: testTokens[account], WOODPECKER_TOKEN: "test-woodpecker" },
});

export function testEnvironment(): Record<string, string | undefined> {
  return {
    ...process.env,
    GITHUB_TOKEN_NOVAN_XU: testTokens["novan-xu"],
    GITHUB_TOKEN_NUOFAN_ISLAND: testTokens["nuofan-island"],
  };
}

export function scriptFile(directory: string, source: string, name = `probe-${randomUUID()}.mjs`): string {
  const path = join(directory, name);
  writeFileSync(path, source);
  return path;
}

export function nodeCommand(path: string): string {
  return `"${process.execPath}" "${path}"`;
}

export function nodeScript(directory: string, source: string, name?: string): string {
  return nodeCommand(scriptFile(directory, source, name));
}

export const waitForFile = `
import { existsSync } from "node:fs";
const until = (path) => new Promise((resolve) => {
  const check = () => (existsSync(path) ? resolve() : setTimeout(check, 10));
  check();
});
`;

export function recordingTarget(name: string, environment: Record<string, string | undefined>): Target & { jobs: Job[] } {
  const inner = localTarget({ name, environment });
  const jobs: Job[] = [];
  return {
    name,
    jobs,
    run: (job, sink) => {
      jobs.push(job);
      return inner.run(job, sink);
    },
  };
}

export function textOf(chunks: readonly OutputChunk[], stream?: OutputChunk["stream"]): string {
  return chunks
    .filter((chunk) => stream === undefined || chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join("");
}

export function waitForOutput(service: CommandService, id: string, text: string): Promise<OutputChunk[]> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const chunks = service.output(id);
      if (textOf(chunks).includes(text)) {
        unsubscribe();
        resolve(chunks);
        return true;
      }
      const record = service.get(id);
      if (record !== undefined && record.endedAt !== null) {
        unsubscribe();
        reject(new Error(`Command ended as ${record.state} without printing ${text}: ${textOf(chunks)}`));
        return true;
      }
      return false;
    };
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "output" ? event.chunk.command === id : event.command.id === id) {
        check();
      }
    });
    check();
  });
}

export function waitForState(service: CommandService, id: string, state: CommandRecord["state"]): Promise<CommandRecord> {
  return new Promise((resolve) => {
    const current = service.get(id);
    if (current?.state === state) {
      resolve(current);
      return;
    }
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "command" && event.command.id === id && event.command.state === state) {
        unsubscribe();
        resolve(event.command);
      }
    });
  });
}
