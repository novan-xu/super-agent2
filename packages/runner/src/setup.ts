import { decodeRunnerSetup, type RunnerSetup } from "@super-agent2/protocol";
import { formatSettings, readSettingsFile, settingNames } from "./config.js";
import { type Execute, executeQuietly, writeSecretFile } from "./secret-file.js";

export type AskLine = (question: string) => Promise<string | undefined>;

export interface SetupOptions {
  readonly settingsFile: string;
  readonly ask: AskLine;
  readonly say: (line: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly execute?: Execute;
}

export function settingsFor(setup: RunnerSetup, secret: string, kept: Readonly<Record<string, string>> = {}): Record<string, string> {
  const values: Record<string, string> = { ...kept };
  values[settingNames.hub] = setup.hub;
  values[settingNames.name] = setup.name;
  values[settingNames.accessClientId] = setup.accessClientId;
  values[settingNames.accessClientSecret] = secret;
  values[settingNames.runnerToken] = setup.runnerToken;
  return values;
}

export async function runSetup(options: SetupOptions): Promise<boolean> {
  const line = await options.ask("Paste the line the hub printed when the machine was added: ");
  const setup = line === undefined ? undefined : decodeRunnerSetup(line);
  if (setup === undefined) {
    options.say("That is not the line the hub printed; nothing was changed.");
    return false;
  }
  let secret = setup.accessClientSecret;
  if (secret === undefined) {
    const answer = (await options.ask(`Paste the client secret of the Access service token ${setup.accessClientId}: `))?.trim() ?? "";
    if (answer === "") {
      options.say("No client secret was given; nothing was changed.");
      return false;
    }
    secret = answer;
  }
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(readSettingsFile(options.settingsFile) ?? {})) {
    if (!(Object.values(settingNames) as string[]).includes(name) || name === settingNames.slots) {
      kept[name] = value;
    }
  }
  writeSecretFile(options.settingsFile, formatSettings(settingsFor(setup, secret, kept)), options.platform ?? process.platform, options.execute ?? executeQuietly);
  options.say(`Saved the settings of ${setup.name} in ${options.settingsFile}, readable only by this user.`);
  return true;
}
