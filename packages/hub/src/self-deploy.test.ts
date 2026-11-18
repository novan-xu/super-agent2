import { readFileSync } from "node:fs";
import { deploymentVariables, readDeploymentFile } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { findIrreversible, lockSettings } from "./irreversible.js";

function repositoryFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("Super-agent2's own deployment file", () => {
  const reading = readDeploymentFile(repositoryFile(".superagent2/deployment.json"));

  it("is a deployment file of the shape every hub since #17 reads", () => {
    expect(reading.ok).toBe(true);
  });

  it("hands the release to the deploy script on the NAS of the hub's own instance, by deployment and commit", () => {
    if (!reading.ok) {
      throw new Error(reading.reason);
    }
    const { file } = reading;
    expect(file.target).toBe("hub");
    const commands = { begin: file.deploy, outcome: file.health.command, settle: file.rollback };
    for (const [step, command] of Object.entries(commands)) {
      expect(command).toContain('"$NAS_SSH_DESTINATION" bash "/share/Container/${SUPERAGENT2_INSTANCE:?');
      expect(command).toContain(`/deploy.sh\" ${step} \"$${deploymentVariables.deployment}\" \"$${deploymentVariables.commit}\"`);
      expect(command).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
    }
  });

  it("holds none of its commands behind the confirmation lock", () => {
    if (!reading.ok) {
      throw new Error(reading.reason);
    }
    const settings = lockSettings({ projectFolders: ["/share/Container/superagent2/projects"] });
    for (const command of [reading.file.deploy, reading.file.health.command, reading.file.rollback]) {
      expect(findIrreversible({ command, cwd: null }, settings)).toBeUndefined();
    }
  });
});

describe("the Compose file", () => {
  it("names nothing of one instance, so the live system and a rehearsal share it", () => {
    const compose = repositoryFile("deploy/compose.yaml");
    expect(compose).not.toMatch(/superagent2-(hub|brain|tunnel)\b/);
    expect(compose).not.toContain("/share/Container/superagent2/projects");
    expect(compose).not.toContain("18180");
    expect(compose).toContain("container_name: ${SUPERAGENT2_PROJECT}-hub");
  });
});
