import type { ProgramId } from "@super-agent2/protocol";
import { z } from "zod";
import { allowanceSources, hasAntigravityAccount, readDshAt, supportsAntigravityUsage } from "./allowance.js";
import type { Prober } from "./programs.js";

type Environment = Readonly<Record<string, string | undefined>>;
const ClaudeStatus = z.object({ loggedIn: z.boolean() });

export async function programSignedIn(id: ProgramId, path: string, version: string | null, environment: Environment, prober: Prober): Promise<boolean> {
  try {
    if (id === "codex") {
      const answer = await prober.capture(path, ["login", "status"], { stderr: true, limitMilliseconds: 8_000 });
      return /^Logged in\b/im.test(answer);
    }
    if (id === "claude") {
      if (environment.ANTHROPIC_API_KEY?.trim() || environment.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
      const answer = await prober.capture(path, ["auth", "status", "--json"], { limitMilliseconds: 8_000 });
      return ClaudeStatus.safeParse(JSON.parse(answer)).data?.loggedIn === true;
    }
    if (id === "dsh") {
      const answer = await readDshAt(prober, path, Date.now);
      return answer.program === "dsh" && answer.available === true;
    }
    const source = allowanceSources.find(({ program }) => program === id);
    if (source === undefined || !supportsAntigravityUsage(version)) return false;
    return hasAntigravityAccount(await prober.capture(path, source.args, source.options));
  } catch {
    return false;
  }
}
