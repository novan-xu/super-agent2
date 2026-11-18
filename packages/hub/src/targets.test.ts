import { describe, expect, it } from "vitest";
import { environmentCredentials, forwardedVariables } from "./credentials.js";
import { defaultTargets } from "./hub.js";
import { commandEnvironment } from "./targets.js";

describe("commandEnvironment", () => {
  it("keeps the hub's environment, drops both account tokens and adds the credentials", () => {
    const environment = commandEnvironment(
      { PATH: "/bin", GITHUB_TOKEN_NOVAN_XU: "a", GITHUB_TOKEN_NUOFAN_ISLAND: "b", GH_TOKEN: "old", EMPTY: undefined },
      { GH_TOKEN: "new", GITHUB_TOKEN: "new" },
    );
    expect(environment).toEqual({ PATH: "/bin", GH_TOKEN: "new", GITHUB_TOKEN: "new" });
  });

  it("replaces a variable whose name differs only in case", () => {
    expect(commandEnvironment({ gh_token: "old" }, { GH_TOKEN: "new" })).toEqual({ GH_TOKEN: "new" });
  });
});

describe("environmentCredentials", () => {
  const environment = {
    GITHUB_TOKEN_NOVAN_XU: "token-a",
    GITHUB_TOKEN_NUOFAN_ISLAND: "token-b",
    WOODPECKER_SERVER: "https://ci.example.com",
    WOODPECKER_TOKEN: "token-w",
    CLOUDFLARE_API_TOKEN: "token-c",
    ACCESS_AUD: "not-forwarded",
  };

  it("gives the chosen account's token as GH_TOKEN and GITHUB_TOKEN, with Woodpecker and Cloudflare", () => {
    const source = environmentCredentials(environment);
    expect(source("novan-xu")).toEqual({
      ok: true,
      credentials: {
        GH_TOKEN: "token-a",
        GITHUB_TOKEN: "token-a",
        WOODPECKER_SERVER: "https://ci.example.com",
        WOODPECKER_TOKEN: "token-w",
        CLOUDFLARE_API_TOKEN: "token-c",
      },
    });
    const island = source("nuofan-island");
    expect(island.ok && island.credentials["GH_TOKEN"]).toBe("token-b");
    expect(forwardedVariables).not.toContain("ACCESS_AUD");
  });

  it("names the missing variable and never a value", () => {
    const result = environmentCredentials({ GITHUB_TOKEN_NOVAN_XU: "token-a" })("nuofan-island");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("GITHUB_TOKEN_NUOFAN_ISLAND");
    expect(JSON.stringify(result)).not.toContain("token-a");
  });
});

describe("the hub's targets", () => {
  it("are the hub's own container alone, whatever the environment names", () => {
    const environment = { NAS_SSH_DESTINATION: "owner@nas.local", NAS_SSH_IDENTITY: "/run/secrets/nas_key" };
    expect(defaultTargets(environment).map((target) => target.name)).toEqual(["hub"]);
  });
});
