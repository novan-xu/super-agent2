import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const maximumTrialStarts = 3;

export const RunnerState = z.object({
  current: z.string().min(1),
  currentVersion: z.string().optional(),
  previous: z.string().min(1).optional(),
  previousVersion: z.string().optional(),
  trial: z.number().int().nonnegative().optional(),
  failed: z
    .object({
      version: z.string(),
      reason: z.string(),
      at: z.number().int(),
      permanent: z.boolean(),
    })
    .optional(),
});
export type RunnerState = z.infer<typeof RunnerState>;

export interface EntryFiles {
  readonly entry: string;
  readonly state: string;
  readonly versions: string;
}

export function entryFiles(home: string): EntryFiles {
  return { entry: join(home, "start.mjs"), state: join(home, "version.json"), versions: join(home, "versions") };
}

export function bootstrapSource(fallback: string): string {
  return [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    `const fallback = ${JSON.stringify(fallback)};`,
    'const statePath = new URL("./version.json", import.meta.url);',
    "let main = fallback;",
    "try {",
    '  const state = JSON.parse(readFileSync(statePath, "utf8"));',
    '  main = typeof state.current === "string" ? state.current : fallback;',
    '  if (process.argv[2] === "run" && typeof state.trial === "number" && typeof state.previous === "string") {',
    `    const next = state.trial >= ${maximumTrialStarts}`,
    "      ? {",
    "          current: state.previous,",
    '          ...(typeof state.previousVersion === "string" ? { currentVersion: state.previousVersion } : {}),',
    "          failed: {",
    '            version: typeof state.currentVersion === "string" ? state.currentVersion : "unknown",',
    `            reason: "It stopped ${maximumTrialStarts} times before it reached the hub, so the runner went back to the version before it.",`,
    "            at: Date.now(),",
    "            permanent: true,",
    "          },",
    "        }",
    "      : { ...state, trial: state.trial + 1 };",
    "    writeFileSync(statePath, JSON.stringify(next, null, 2));",
    "    main = next.current;",
    "  }",
    "} catch {",
    "  main = fallback;",
    "}",
    "await import(pathToFileURL(main).href);",
    "",
  ].join("\n");
}

export function readState(files: EntryFiles): RunnerState | undefined {
  try {
    const parsed = RunnerState.safeParse(JSON.parse(readFileSync(files.state, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(files: EntryFiles, state: RunnerState): void {
  writeFileSync(files.state, `${JSON.stringify(RunnerState.parse(state), null, 2)}\n`);
}

function writeEntry(home: string, files: EntryFiles, fallback: string): void {
  mkdirSync(home, { recursive: true });
  const source = bootstrapSource(fallback);
  let current: string | undefined;
  try {
    current = readFileSync(files.entry, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== source) {
    writeFileSync(files.entry, source);
  }
}

export function installEntry(home: string, mainPath: string, version: string | undefined): EntryFiles {
  const files = entryFiles(home);
  writeEntry(home, files, mainPath);
  writeState(files, { current: mainPath, ...(version === undefined ? {} : { currentVersion: version }) });
  return files;
}

export function ensureEntry(home: string, mainPath: string, version: string | undefined): EntryFiles {
  const files = entryFiles(home);
  const state = readState(files);
  if (!existsSync(files.entry) || state === undefined) {
    return installEntry(home, state?.current ?? mainPath, state === undefined ? version : state.currentVersion);
  }
  return files;
}

export function refreshEntry(home: string, fallback: string): void {
  writeEntry(home, entryFiles(home), fallback);
}
