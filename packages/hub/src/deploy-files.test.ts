import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function repositoryPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

function repositoryFile(path: string): string {
  return readFileSync(repositoryPath(path), "utf8");
}

describe("Super-agent2's own repository", () => {
  it("declares no deployment through the hub", () => {
    expect(existsSync(repositoryPath(".superagent2/deployment.json"))).toBe(false);
  });
});

describe("the Compose file", () => {
  const compose = repositoryFile("deploy/compose.yaml");

  it("names nothing of one instance, so the live system and a rehearsal share it", () => {
    expect(compose).not.toMatch(/superagent2-(hub|brain|tunnel)\b/);
    expect(compose).not.toContain("/share/Container/superagent2/projects");
    expect(compose).not.toContain("18180");
    expect(compose).toContain("container_name: ${SUPERAGENT2_PROJECT}-hub");
  });

  it("gives the hub no way to sign in to the NAS host", () => {
    expect(compose).not.toMatch(/NAS_SSH|secrets\/ssh|host\.docker\.internal|host-gateway|SUPERAGENT2_INSTANCE/);
    expect(compose).not.toMatch(/docker\.sock/);
  });
});

describe("the deploy script", () => {
  const script = repositoryFile("deploy/deploy.sh");

  it("has no step that lets the hub sign in to the NAS host or that only the hub called", () => {
    expect(script).not.toMatch(/ssh-keygen|step_authorize|step_begin|step_outcome|step_settle/);
    expect(script).not.toMatch(/^\s+(authorize|begin|outcome|settle)\)/m);
    expect(script).toMatch(/^\s+deauthorize\) step_deauthorize ;;$/m);
    expect(script).toMatch(/^\s+release\) step_release "\$@" ;;$/m);
  });
});

describe.skipIf(process.platform === "win32")("deauthorize, run by bash", () => {
  const hubKey = "AAAAC3NzaC1lZDI1NTE5AAAAIHubKeyOfAnEarlierVersion0000000000000000";
  const otherKey = "AAAAC3NzaC1lZDI1NTE5AAAAIOwnersOwnLaptopKey00000000000000000000000";
  let home: string;
  let root: string;
  let keys: string;

  function run(step: string): { readonly code: number | null; readonly output: string } {
    const result = spawnSync("bash", [repositoryPath("deploy/deploy.sh"), step], {
      env: { PATH: process.env["PATH"] ?? "", HOME: home, SUPERAGENT2_ROOT: root },
      encoding: "utf8",
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "deploy-home-"));
    root = join(home, "superagent2-rehearsal");
    mkdirSync(join(root, "secrets", "ssh"), { recursive: true });
    writeFileSync(join(root, "instance.env"), "HUB_PORT=18999\n");
    mkdirSync(join(home, ".ssh"));
    keys = join(home, ".ssh", "authorized_keys");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("removes the hub's key and keeps every other line, with a copy of the file before", () => {
    writeFileSync(join(root, "secrets", "ssh", "nas_ed25519.pub"), `ssh-ed25519 ${hubKey} superagent2-rehearsal-hub\n`);
    const before = `ssh-ed25519 ${otherKey} owner@laptop\nfrom="10.0.0.0/8,172.16.0.0/12",no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${hubKey} superagent2-rehearsal-hub\n`;
    writeFileSync(keys, before);
    const result = run("deauthorize");
    expect(result.code).toBe(0);
    expect(readFileSync(keys, "utf8")).toBe(`ssh-ed25519 ${otherKey} owner@laptop\n`);
    const copies = readdirSync(join(root, "backups"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(root, "backups", copies[0] ?? ""), "utf8")).toBe(before);
    expect(run("deauthorize")).toMatchObject({ code: 0, output: expect.stringContaining("the hub's key is not authorized") });
  });

  it("changes nothing when the public key file holds no key", () => {
    writeFileSync(join(root, "secrets", "ssh", "nas_ed25519.pub"), "\n");
    const before = `ssh-ed25519 ${otherKey} owner@laptop\n`;
    writeFileSync(keys, before);
    expect(run("deauthorize").code).not.toBe(0);
    expect(readFileSync(keys, "utf8")).toBe(before);
  });

  it.each(["authorize", "begin", "outcome", "settle"])("does not know the step %s", (step) => {
    expect(run(step).code).toBe(2);
  });
});
