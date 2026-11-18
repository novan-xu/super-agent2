import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRecord } from "@super-agent2/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessVerifier } from "./access.js";
import { type CommandService, createCommandService } from "./commands.js";
import { type HubDatabase, openDatabase } from "./database.js";
import { lockSettings } from "./irreversible.js";
import { createKeyCache } from "./keys.js";
import { changedReason, type ConfirmationLock, createConfirmationLock, fingerprintOf, refusedReason } from "./lock.js";
import type { Job, Target } from "./targets.js";
import {
  assertion,
  audience,
  keySet,
  personClaims,
  serviceClaims,
  signingKey,
  type SigningKey,
  staticKeySource,
  team,
  TestClock,
  ownerEmail,
} from "./testing/access.js";
import { fakeTarget, testCredentials, waitForState } from "./testing/commands.js";

let dataDir: string;
let clock: TestClock;
let key: SigningKey;
let database: HubDatabase;
let service: CommandService | undefined;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hub-lock-"));
  clock = new TestClock();
  key = await signingKey("key-1");
  database = openDatabase({ dataDir, clock });
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function create(): { running: CommandService; lock: ConfirmationLock; hub: Target & { jobs: Job[] }; studio: Target & { jobs: Job[] } } {
  const keys = createKeyCache({ source: staticKeySource(keySet(key)), clock });
  const verify = createAccessVerifier({ team, audience, keys, clock });
  const lock = createConfirmationLock({
    database,
    clock,
    verify,
    ownerEmail,
    settings: lockSettings({ projectFolders: ["/srv/projects"] }),
  });
  const hub = fakeTarget("hub");
  const studio = fakeTarget("studio");
  service = createCommandService({ database, clock, targets: [hub, studio], credentials: testCredentials, gate: lock.gate });
  return { running: service, lock, hub, studio };
}

async function owner(): Promise<string> {
  return assertion({ key, clock });
}

async function finished(running: CommandService, id: string): Promise<CommandRecord> {
  const record = await running.finished(id);
  if (record === undefined) {
    throw new Error(`Command ${id} is unknown`);
  }
  return record;
}

describe("the confirmation lock", () => {
  it("lets a command that is not on the list run without waiting", async () => {
    const { running, lock, hub } = create();
    const { id } = running.start({ target: "hub", command: "git push origin main", cwd: "/srv/projects/app" });
    expect(await finished(running, id)).toMatchObject({ state: "exited", exitCode: 0 });
    expect(hub.jobs.map((job) => job.command)).toEqual(["git push origin main"]);
    expect(lock.get(id)).toBeUndefined();
  });

  it("holds a command on the list, says why, and does not run it", async () => {
    const { running, lock, studio } = create();
    const { id } = running.start({ target: "studio", command: "docker volume rm superagent-data" });
    const held = await waitForState(running, id, "held");
    expect(held.reason).toBe("等你确认：删除数据库或数据卷（docker volume rm superagent-data）");
    expect(studio.jobs).toEqual([]);
    expect(lock.waiting().map((hold) => hold.command)).toEqual([id]);
    expect(lock.get(id)).toMatchObject({
      form: "data-deletion",
      evidence: "docker volume rm superagent-data",
      fingerprint: fingerprintOf(held),
      heldAt: clock.now(),
      answer: null,
    });
  });

  it("runs a held command exactly as it was held once the owner releases it", async () => {
    const { running, lock, hub } = create();
    const request = { target: "hub", command: "gh repo delete novan-xu/old --yes", account: "nuofan-island", cwd: "/srv/projects/app" } as const;
    const { id } = running.start(request);
    const held = await waitForState(running, id, "held");
    clock.advance(5_000);
    const outcome = await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) });
    expect(outcome).toMatchObject({ ok: true, hold: { answer: "released", answeredAt: clock.now(), answeredBy: ownerEmail } });
    expect(await finished(running, id)).toMatchObject({ state: "exited", ...request });
    expect(hub.jobs).toHaveLength(1);
    expect(hub.jobs[0]).toMatchObject({ command: request.command, cwd: request.cwd });
    expect(hub.jobs[0]?.credentials["GH_TOKEN"]).toBe("test-token-for-nuofan-island");
    expect(lock.waiting()).toEqual([]);
  });

  it("drops a held command the owner refuses", async () => {
    const { running, lock, hub } = create();
    const { id } = running.start({ target: "hub", command: "gh repo edit --visibility public" });
    const held = await waitForState(running, id, "held");
    const outcome = await lock.refuse(id, { assertion: await owner(), fingerprint: fingerprintOf(held) });
    expect(outcome).toMatchObject({ ok: true, hold: { answer: "refused" } });
    expect(await finished(running, id)).toMatchObject({ state: "dropped", reason: refusedReason });
    expect(hub.jobs).toEqual([]);
  });

  it("tells a subscriber the command is held and later what happened to it", async () => {
    const { running, lock } = create();
    const states: string[] = [];
    running.subscribe((event) => {
      if (event.type === "command") {
        states.push(event.command.state);
      }
    });
    const { id } = running.start({ target: "hub", command: "git push --force origin main" });
    const held = await waitForState(running, id, "held");
    await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) });
    await finished(running, id);
    expect(states).toEqual(["pending", "held", "running", "exited"]);
  });

  it("refuses a release by a service token, by no one, and by another person", async () => {
    const { running, lock, hub } = create();
    const { id } = running.start({ target: "hub", command: "rm -rf /volume1/docker" });
    const held = await waitForState(running, id, "held");
    const fingerprint = fingerprintOf(held);
    const serviceToken = await assertion({ key, clock, claims: serviceClaims() });
    const stranger = await assertion({ key, clock, claims: personClaims("someone@example.com") });
    const forged = await assertion({ key: await signingKey("key-1"), clock });
    for (const given of [serviceToken, stranger, forged, undefined, ""]) {
      expect(await lock.release(id, { assertion: given, fingerprint })).toEqual({ ok: false, error: "forbidden" });
      expect(await lock.refuse(id, { assertion: given, fingerprint })).toEqual({ ok: false, error: "forbidden" });
    }
    expect(running.get(id)?.state).toBe("held");
    expect(lock.get(id)?.answer).toBeNull();
    expect(hub.jobs).toEqual([]);
  });

  it("refuses a release that does not name exactly what was held", async () => {
    const { running, lock } = create();
    const first = running.start({ target: "hub", command: "gh repo delete novan-xu/a --yes" });
    const second = running.start({ target: "hub", command: "gh repo delete novan-xu/b --yes" });
    const heldFirst = await waitForState(running, first.id, "held");
    await waitForState(running, second.id, "held");
    const token = await owner();
    expect(await lock.release(second.id, { assertion: token, fingerprint: fingerprintOf(heldFirst) })).toEqual({ ok: false, error: "conflict" });
    expect(await lock.release(second.id, { assertion: token, fingerprint: "0".repeat(64) })).toEqual({ ok: false, error: "conflict" });
    expect(await lock.release("unknown", { assertion: token, fingerprint: fingerprintOf(heldFirst) })).toEqual({ ok: false, error: "not_found" });
    expect(running.get(second.id)?.state).toBe("held");
  });

  it("answers a hold only once", async () => {
    const { running, lock } = create();
    const { id } = running.start({ target: "hub", command: "docker compose down -v" });
    const held = await waitForState(running, id, "held");
    const given = { assertion: await owner(), fingerprint: fingerprintOf(held) };
    expect((await lock.refuse(id, given)).ok).toBe(true);
    expect(await lock.release(id, given)).toEqual({ ok: false, error: "conflict" });
    expect(await finished(running, id)).toMatchObject({ state: "dropped" });
  });

  it("lets the caller stop a held command, which is then no longer releasable", async () => {
    const { running, lock, hub } = create();
    const { id } = running.start({ target: "hub", command: "docker volume prune -f" });
    const held = await waitForState(running, id, "held");
    running.stop(id);
    expect(await finished(running, id)).toMatchObject({ state: "stopped" });
    expect(lock.get(id)?.answer).toBe("withdrawn");
    expect(await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) })).toEqual({ ok: false, error: "conflict" });
    expect(hub.jobs).toEqual([]);
  });

  it("keeps a held command across a restart and runs it exactly as held once released", async () => {
    const first = create();
    const request = { target: "studio", command: "rm -rf /volume1/docker/old-app", account: "novan-xu", cwd: "/volume1" } as const;
    const { id } = first.running.start(request);
    const held = await waitForState(first.running, id, "held");
    await first.running.close();
    service = undefined;
    expect(first.running.get(id)?.state).toBe("held");
    clock.advance(3_600_000);
    const second = create();
    expect(second.running.get(id)).toMatchObject({ state: "held", reason: held.reason, endedAt: null });
    expect(second.lock.waiting().map((hold) => hold.command)).toEqual([id]);
    expect(await second.lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) })).toMatchObject({ ok: true });
    expect(await finished(second.running, id)).toMatchObject({ state: "exited", ...request });
    expect(second.studio.jobs.map((job) => [job.command, job.cwd])).toEqual([[request.command, request.cwd]]);
    expect(first.studio.jobs).toEqual([]);
  });

  it("ties a hold to the command's environment, in any order of its names, and releases only that", async () => {
    const { running, lock, studio } = create();
    const environment = { SUPERAGENT2_PREVIOUS_COMMIT: "1111111", SUPERAGENT2_COMMIT: "2222222" };
    const { id } = running.start({ target: "studio", command: "rm -rf /volume1/docker/releases/$SUPERAGENT2_COMMIT", environment });
    const held = await waitForState(running, id, "held");
    expect(held.environment).toEqual(environment);
    const reordered = { ...held, environment: { SUPERAGENT2_COMMIT: "2222222", SUPERAGENT2_PREVIOUS_COMMIT: "1111111" } };
    expect(fingerprintOf(reordered)).toBe(fingerprintOf(held));
    expect(fingerprintOf({ ...held, environment: { ...environment, SUPERAGENT2_PREVIOUS_COMMIT: "3333333" } })).not.toBe(fingerprintOf(held));
    expect(fingerprintOf({ ...held, environment: {} })).not.toBe(fingerprintOf(held));
    expect(lock.get(id)?.fingerprint).toBe(fingerprintOf(held));
    expect(await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf({ ...held, environment: {} }) })).toEqual({ ok: false, error: "conflict" });
    expect(await lock.release(id, { assertion: await owner(), fingerprint: fingerprintOf(held) })).toMatchObject({ ok: true });
    await finished(running, id);
    expect(studio.jobs[0]?.credentials).toMatchObject(environment);
  });

  it("keeps the fingerprint of a command without environment as it was before commands had one, so holds stored then stay releasable", async () => {
    const first = create();
    const request = { target: "studio", command: "rm -rf /volume1/docker/old-app", account: "novan-xu", cwd: "/volume1" } as const;
    const { id } = first.running.start(request);
    const held = await waitForState(first.running, id, "held");
    const before = createHash("sha256").update(JSON.stringify([held.id, held.target, held.command, held.account, held.cwd])).digest("hex");
    expect(fingerprintOf(held)).toBe(before);
    await first.running.close();
    service = undefined;
    database.connection.prepare("UPDATE commands SET environment = NULL WHERE id = ?").run(id);
    database.connection.prepare("UPDATE holds SET fingerprint = ? WHERE command_id = ?").run(before, id);
    const second = create();
    expect(await second.lock.release(id, { assertion: await owner(), fingerprint: before })).toMatchObject({ ok: true });
    expect(await finished(second.running, id)).toMatchObject({ state: "exited" });
  });

  it("drops a held command whose environment changed while the hub was down", async () => {
    const first = create();
    const { id } = first.running.start({ target: "studio", command: "rm -rf /volume1/docker/releases/$SUPERAGENT2_COMMIT", environment: { SUPERAGENT2_COMMIT: "2222222" } });
    await waitForState(first.running, id, "held");
    await first.running.close();
    service = undefined;
    database.connection.prepare("UPDATE commands SET environment = ? WHERE id = ?").run(JSON.stringify({ SUPERAGENT2_COMMIT: ".." }), id);
    const second = create();
    expect(await finished(second.running, id)).toMatchObject({ state: "dropped", reason: changedReason });
    expect(second.studio.jobs).toEqual([]);
  });

  it("drops a held command whose stored text changed while the hub was down", async () => {
    const first = create();
    const { id } = first.running.start({ target: "hub", command: "gh repo delete novan-xu/old --yes" });
    await waitForState(first.running, id, "held");
    await first.running.close();
    service = undefined;
    database.connection.prepare("UPDATE commands SET command = ? WHERE id = ?").run("gh repo delete novan-xu/precious --yes", id);
    const second = create();
    expect(await finished(second.running, id)).toMatchObject({ state: "dropped", reason: changedReason });
    expect(second.hub.jobs).toEqual([]);
  });
});
