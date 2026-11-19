import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDeploymentFile } from "@super-agent2/protocol";
import { bgeSmallZh } from "@super-agent2/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function repositoryPath(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

function repositoryFile(path: string): string {
  return readFileSync(repositoryPath(path), "utf8");
}

describe("Super-agent2's own repository", () => {
  it("declares its deployment as a recipe for a worker on a machine that signs in to the NAS, releasing the commit of its checkout", () => {
    expect(existsSync(repositoryPath(".superagent2/deployment.json"))).toBe(true);
    const reading = readDeploymentFile(repositoryFile(".superagent2/deployment.json"));
    if (!reading.ok) {
      throw new Error(reading.reason);
    }
    expect(reading.file.target).toBe("mac-mini");
    expect(reading.file.deploy).toContain("ssh novan-nas-maintenance");
    expect(reading.file.deploy).toContain("deploy.sh release $(git rev-parse HEAD)");
    expect(reading.file.health.command).toContain("deploy.sh health");
    expect(reading.file.rollback).toContain("deploy.sh rollback");
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

describe("the image", () => {
  const dockerfile = repositoryFile("deploy/Dockerfile");

  it("bakes the routing model at the revision and checksums the hub expects and points the hub at it", () => {
    expect(dockerfile).toContain(`ARG ROUTING_MODEL=${bgeSmallZh.model}`);
    expect(dockerfile).toContain(`ARG ROUTING_MODEL_REVISION=${bgeSmallZh.revision}`);
    for (const file of bgeSmallZh.files) {
      expect(dockerfile).toContain(`"${file.path} ${file.sha256}"`);
    }
    expect(dockerfile).toContain("sha256sum --check --strict");
    expect(dockerfile).toContain("COPY --from=routing-model /models /opt/superagent2/models");
    expect(dockerfile).toMatch(/^ENV .*HUB_ROUTING_MODELS=\/opt\/superagent2\/models/m);
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

describe.skipIf(process.platform === "win32")("release startup, run by bash", () => {
  let home: string;
  let root: string;
  let log: string;
  const commit = "a".repeat(40);
  const previous = "b".repeat(40);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "deploy-release-"));
    root = join(home, "superagent2-test");
    log = join(home, "docker.log");
    for (const dir of [root, join(root, "src"), join(root, "incoming"), join(home, "bin"), join(home, "target", "deploy")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(root, "instance.env"), "HUB_PORT=18999\n");
    writeFileSync(join(root, "src", ".revision"), `${previous}\n`);
    writeFileSync(join(root, "deploy.sh"), repositoryFile("deploy/deploy.sh"));
    writeFileSync(join(root, "compose.yaml"), "SUPERAGENT2_PROJECT old\n");
    writeFileSync(join(home, "target", "deploy", "Dockerfile"), "fixture\n");
    writeFileSync(join(home, "target", "deploy", "compose.yaml"), "SUPERAGENT2_PROJECT new\n");
    const targetScript = repositoryFile("deploy/deploy.sh").replace(
      "  local expected=$1 services service running",
      '  printf "target startup\\n" >> "$TEST_LOG"\n  local expected=$1 services service running',
    );
    writeFileSync(join(home, "target", "deploy", "deploy.sh"), targetScript);
    const tar = spawnSync("tar", ["-cf", join(root, "incoming", `${commit}.tar`), "-C", join(home, "target"), "."]);
    expect(tar.status).toBe(0);
    writeFileSync(join(home, "bin", "docker"), `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_LOG"
case " $* " in
  *' config --services '*) printf 'hub\\nbrain\\n'; if grep -q new "$SUPERAGENT2_ROOT/compose.yaml"; then printf 'converter\\n'; fi ;;
  *' ps --services --status running '*) printf 'hub\\nbrain\\n'; if grep -q new "$SUPERAGENT2_ROOT/compose.yaml" && [ "\${MISSING_SERVICE:-}" != yes ]; then printf 'converter\\n'; fi ;;
  *' volume inspect '*) exit 1 ;;
  *' inspect -f '*) echo started ;;
  *' logs --since '*) echo 'Linked to the hub' ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(home, "bin", "curl"), '#!/bin/bash\nprintf \'{"status":"ok"}\\n\'\n', { mode: 0o755 });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function release(missing = false) {
    return spawnSync("bash", [join(root, "deploy.sh"), "release", commit], {
      env: { ...process.env, PATH: `${join(home, "bin")}:${process.env["PATH"] ?? ""}`, SUPERAGENT2_ROOT: root, DOCKER: join(home, "bin", "docker"), TEST_LOG: log, MISSING_SERVICE: missing ? "yes" : "" },
      encoding: "utf8",
    });
  }

  it("runs the target script and starts a service added by its Compose file", () => {
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("target startup");
    expect(calls).toContain("up -d --no-deps converter");
    expect(calls.indexOf("up -d --no-deps converter")).toBeLessThan(calls.indexOf("up -d --no-deps hub"));
  });

  it("uses the generic startup when the target predates the internal entry point", () => {
    const path = join(home, "target", "deploy", "deploy.sh");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^    start-services\).*\n/m, ""));
    expect(spawnSync("tar", ["-cf", join(root, "incoming", `${commit}.tar`), "-C", join(home, "target"), "."]).status).toBe(0);
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("has no start-services entry point");
    expect(readFileSync(log, "utf8")).toContain("up -d --no-deps converter");
  });

  it("rolls back when a default service is missing and starts the restored version", () => {
    const result = release(true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the service converter is not running");
    expect(result.stderr).toContain("ended rolled-back");
    expect(readFileSync(join(root, "src", ".revision"), "utf8").trim()).toBe(previous);
    expect(readFileSync(log, "utf8").match(/target startup/g)).toHaveLength(1);
  });
});
