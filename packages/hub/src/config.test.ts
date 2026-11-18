import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPageDir, loadConfig } from "./config.js";
import { generateVapidKeys } from "./push.js";

const valid = {
  ACCESS_TEAM: "example-team",
  ACCESS_AUD: "0123456789abcdef".repeat(4),
  OWNER_EMAIL: "Owner@Example.com",
  HUB_DATA_DIR: "/data",
};

function problemsFor(env: Record<string, string | undefined>): readonly string[] {
  const result = loadConfig(env);
  if (result.ok) {
    throw new Error("expected an invalid configuration");
  }
  return result.problems;
}

describe("loadConfig", () => {
  it("accepts a complete environment and fills in the defaults", () => {
    expect(loadConfig(valid)).toEqual({
      ok: true,
      config: {
        accessTeam: "example-team",
        accessAudience: valid.ACCESS_AUD,
        ownerEmail: "owner@example.com",
        dataDir: "/data",
        port: 8080,
        host: "0.0.0.0",
        projectFolders: [],
        brainTokenFile: join("/data", "brain.token"),
        pageDir: defaultPageDir,
        attachmentsDir: join("/data", "attachments"),
      },
    });
  });

  it("reads the runner application's own audience, which must differ from the host's", () => {
    const runner = "fedcba9876543210".repeat(4);
    const result = loadConfig({ ...valid, ACCESS_RUNNER_AUD: runner });
    expect(result.ok && result.config.accessRunnerAudience).toBe(runner);
    expect(problemsFor({ ...valid, ACCESS_RUNNER_AUD: "runner" })[0]).toMatch(/^ACCESS_RUNNER_AUD must be the runner application's audience tag/);
    expect(problemsFor({ ...valid, ACCESS_RUNNER_AUD: valid.ACCESS_AUD })[0]).toMatch(/^ACCESS_RUNNER_AUD must be the audience tag of the separate application/);
  });

  it("serves the page built next to the hub unless told otherwise", () => {
    expect(defaultPageDir.replaceAll("\\", "/")).toMatch(/\/packages\/web\/dist\/?$/);
    const result = loadConfig({ ...valid, HUB_PAGE_DIR: "/srv/page" });
    expect(result.ok && result.config.pageDir).toBe("/srv/page");
  });

  it("keeps the brain's token in the data folder unless told otherwise", () => {
    const result = loadConfig({ ...valid, HUB_BRAIN_TOKEN_FILE: "/run/secrets/brain.token" });
    expect(result.ok && result.config.brainTokenFile).toBe("/run/secrets/brain.token");
  });

  it("reads the first-time allowance for a pipeline, in minutes", () => {
    expect(loadConfig(valid)).toMatchObject({ ok: true, config: expect.not.objectContaining({ firstPipelineAllowanceMinutes: expect.anything() }) });
    const result = loadConfig({ ...valid, HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES: "90" });
    expect(result.ok && result.config.firstPipelineAllowanceMinutes).toBe(90);
    expect(problemsFor({ ...valid, HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES: "0" })[0]).toMatch(/^HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES must be at least 1/);
    expect(problemsFor({ ...valid, HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES: "two hours" })[0]).toMatch(/^HUB_FIRST_PIPELINE_ALLOWANCE_MINUTES must be a whole number of minutes/);
  });

  it("reads the configurable DeepSeek low balance threshold", () => {
    const result = loadConfig({ ...valid, HUB_DEEPSEEK_LOW_BALANCE: "42.5" });
    expect(result.ok && result.config.deepseekLowBalance).toBe(42.5);
    expect(problemsFor({ ...valid, HUB_DEEPSEEK_LOW_BALANCE: "-1" })[0]).toMatch(/^HUB_DEEPSEEK_LOW_BALANCE/);
  });

  it("reads the project folders", () => {
    const result = loadConfig({
      ...valid,
      HUB_PROJECT_FOLDERS: "/srv/projects, ~/work ,C:\work",
    });
    expect(result.ok && result.config.projectFolders).toEqual(["/srv/projects", "~/work", "C:\work"]);
  });

  it("refuses a project folder that is not absolute", () => {
    expect(problemsFor({ ...valid, HUB_PROJECT_FOLDERS: "/srv/projects,projects" })[0]).toMatch(/^HUB_PROJECT_FOLDERS must be absolute folders/);
  });

  it("reads the port and host", () => {
    const result = loadConfig({ ...valid, HUB_PORT: "3000", HUB_HOST: "127.0.0.1" });
    expect(result.ok && result.config.port).toBe(3000);
    expect(result.ok && result.config.host).toBe("127.0.0.1");
  });

  it("starts with the NAS sign-in variables an older instance still sets, and takes nothing from them", () => {
    const result = loadConfig({ ...valid, NAS_SSH_DESTINATION: "-oProxyCommand=x", NAS_SSH_PORT: "none", NAS_SSH_IDENTITY: "/run/superagent2/ssh/nas_ed25519" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ProxyCommand|nas_ed25519/);
  });

  it.each(["ACCESS_TEAM", "ACCESS_AUD", "OWNER_EMAIL", "HUB_DATA_DIR"] as const)("names %s when it is missing", (name) => {
    expect(problemsFor({ ...valid, [name]: undefined })).toEqual([`${name} is required`]);
  });

  it("refuses a team given as a host name", () => {
    const problems = problemsFor({ ...valid, ACCESS_TEAM: "example-team.cloudflareaccess.com" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^ACCESS_TEAM must be the team name alone/);
  });

  it("refuses an audience that is not a tag", () => {
    expect(problemsFor({ ...valid, ACCESS_AUD: "my-app" })[0]).toMatch(/^ACCESS_AUD must be the application's audience tag/);
  });

  it("refuses an owner that is not an email address", () => {
    expect(problemsFor({ ...valid, OWNER_EMAIL: "owner" })).toEqual(["OWNER_EMAIL must be an email address"]);
  });

  it.each(["65536", "http", "-1", "1.5", ""])("refuses the port %s", (port) => {
    expect(problemsFor({ ...valid, HUB_PORT: port })[0]).toMatch(/^HUB_PORT /);
  });

  it("reports every wrong value at once", () => {
    const problems = problemsFor({ ACCESS_TEAM: "Bad Team", OWNER_EMAIL: "x" });
    expect(problems.map((problem) => problem.split(" ")[0])).toEqual(["ACCESS_TEAM", "ACCESS_AUD", "OWNER_EMAIL", "HUB_DATA_DIR"]);
  });

  describe("push keys", () => {
    const keys = generateVapidKeys();
    const given = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };

    it("reads the keys and the contact", () => {
      const result = loadConfig({ ...valid, ...given, VAPID_SUBJECT: "mailto:ops@example.com" });
      expect(result.ok && result.config.vapid).toEqual({ ...keys, subject: "mailto:ops@example.com" });
    });

    it("starts without keys, and treats empty values as absent", () => {
      expect(loadConfig(valid)).toMatchObject({ ok: true });
      expect(loadConfig({ ...valid, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" })).toMatchObject({ ok: true });
      const result = loadConfig(valid);
      expect(result.ok && result.config.vapid).toBeUndefined();
    });

    it("refuses one key without the other, naming the missing one", () => {
      expect(problemsFor({ ...valid, VAPID_PUBLIC_KEY: keys.publicKey })).toEqual(["VAPID_PRIVATE_KEY is required when VAPID_PUBLIC_KEY is set"]);
      expect(problemsFor({ ...valid, VAPID_PRIVATE_KEY: keys.privateKey })).toEqual(["VAPID_PUBLIC_KEY is required when VAPID_PRIVATE_KEY is set"]);
    });

    it("refuses keys that do not belong together without repeating them", () => {
      const problems = problemsFor({ ...valid, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey });
      expect(problems).toEqual(["VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY"]);
      expect(problemsFor({ ...valid, VAPID_PUBLIC_KEY: "not base64!", VAPID_PRIVATE_KEY: keys.privateKey })).toEqual(["VAPID_PUBLIC_KEY must be URL-safe base64"]);
    });

    it("refuses a contact that is neither an address nor an https URL", () => {
      expect(problemsFor({ ...valid, ...given, VAPID_SUBJECT: "http://example.com" })).toEqual(["VAPID_SUBJECT must be a mailto: address or an https URL"]);
    });
  });
});
