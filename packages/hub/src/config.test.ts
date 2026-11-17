import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

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
      },
    });
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
});
