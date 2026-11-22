import { voiceSmokeMain } from "./voice-smoke.js";

process.exitCode = await voiceSmokeMain(process.env, (line) => process.stdout.write(`${line}\n`));
