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
        credentialPaths: [],
        brainTokenFile: join("/data", "brain.token"),
        pageDir: defaultPageDir,
      },
    });
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

  it("reads the project folders and the extra credential paths", () => {
    const result = loadConfig({
      ...valid,
      HUB_PROJECT_FOLDERS: "/srv/projects, ~/work ,C:\work",
      HUB_CREDENTIAL_PATHS: "**/vault/**,!**/vault/README.md",
    });
    expect(result.ok && result.config.projectFolders).toEqual(["/srv/projects", "~/work", "C:\work"]);
    expect(result.ok && result.config.credentialPaths).toEqual(["**/vault/**", "!**/vault/README.md"]);
  });

  it("refuses a project folder that is not absolute", () => {
    expect(problemsFor({ ...valid, HUB_PROJECT_FOLDERS: "/srv/projects,projects" })[0]).toMatch(/^HUB_PROJECT_FOLDERS must be absolute folders/);
  });

  it("reads the port and host", () => {
    const result = loadConfig({ ...valid, HUB_PORT: "3000", HUB_HOST: "127.0.0.1" });
    expect(result.ok && result.config.port).toBe(3000);
    expect(result.ok && result.config.host).toBe("127.0.0.1");
  });

  it("reads the NAS's SSH destination, port and key", () => {
    const result = loadConfig({
      ...valid,
      NAS_SSH_DESTINATION: "owner@nas.local",
      NAS_SSH_PORT: "2222",
      NAS_SSH_IDENTITY: "/run/secrets/nas_key",
    });
    expect(result.ok && result.config.nas).toEqual({
      destination: "owner@nas.local",
      port: 2222,
      identityFile: "/run/secrets/nas_key",
    });
    const plain = loadConfig({ ...valid, NAS_SSH_DESTINATION: "nas" });
    expect(plain.ok && plain.config.nas).toEqual({ destination: "nas" });
  });

  it.each(["-oProxyCommand=x", "owner@nas local", ""])("refuses the SSH destination %j", (destination) => {
    expect(problemsFor({ ...valid, NAS_SSH_DESTINATION: destination })[0]).toMatch(/^NAS_SSH_DESTINATION /);
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
