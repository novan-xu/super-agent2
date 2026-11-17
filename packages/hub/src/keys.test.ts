import type { AccessKeySet } from "@super-agent2/protocol";
import { describe, expect, it } from "vitest";
import { certificatesUrl, createKeyCache, fetchKeySource } from "./keys.js";
import { TestClock } from "./testing/access.js";

const first: AccessKeySet = { keys: [{ kty: "RSA", kid: "one" }] };
const second: AccessKeySet = { keys: [{ kty: "RSA", kid: "one" }, { kty: "RSA", kid: "two" }] };

function sequence(...sets: AccessKeySet[]) {
  let calls = 0;
  const source = async () => {
    const set = sets[Math.min(calls, sets.length - 1)];
    calls += 1;
    if (set === undefined) {
      throw new Error("no key set");
    }
    return set;
  };
  return { source, calls: () => calls };
}

describe("createKeyCache", () => {
  it("fetches once and serves known keys from the cache", async () => {
    const clock = new TestClock();
    const fake = sequence(first);
    const cache = createKeyCache({ source: fake.source, clock });
    expect(await cache.keysFor("one")).toEqual(first);
    clock.advance(60_000);
    expect(await cache.keysFor("one")).toEqual(first);
    expect(fake.calls()).toBe(1);
  });

  it("fetches again for an unknown key only after the cooldown", async () => {
    const clock = new TestClock();
    const fake = sequence(first, second);
    const cache = createKeyCache({ source: fake.source, clock, refreshCooldownMs: 30_000 });
    await cache.keysFor("one");
    expect(await cache.keysFor("two")).toEqual(first);
    expect(fake.calls()).toBe(1);
    clock.advance(30_000);
    expect(await cache.keysFor("two")).toEqual(second);
    expect(fake.calls()).toBe(2);
  });

  it("fetches again when the cache is older than its maximum age", async () => {
    const clock = new TestClock();
    const fake = sequence(first, second);
    const cache = createKeyCache({ source: fake.source, clock, maxAgeMs: 600_000 });
    await cache.keysFor("one");
    clock.advance(600_000);
    expect(await cache.keysFor("one")).toEqual(second);
  });

  it("passes a failed fetch on to the caller", async () => {
    const cache = createKeyCache({
      source: async () => {
        throw new Error("offline");
      },
      clock: new TestClock(),
    });
    await expect(cache.keysFor("one")).rejects.toThrow("offline");
  });

  it("shares one fetch between callers waiting at the same time", async () => {
    const fake = sequence(first);
    const cache = createKeyCache({ source: fake.source, clock: new TestClock() });
    await Promise.all([cache.keysFor("one"), cache.keysFor("one"), cache.keysFor("one")]);
    expect(fake.calls()).toBe(1);
  });
});

describe("fetchKeySource", () => {
  it("reads the team's published certificates", async () => {
    const requested: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json(first);
    };
    expect(await fetchKeySource("example-team", fetcher as typeof fetch)()).toEqual(first);
    expect(requested).toEqual(["https://example-team.cloudflareaccess.com/cdn-cgi/access/certs"]);
    expect(certificatesUrl("example-team")).toBe(requested[0]);
  });

  it("fails on an error status", async () => {
    const fetcher = async () => new Response("nope", { status: 500 });
    await expect(fetchKeySource("example-team", fetcher as typeof fetch)()).rejects.toThrow(/500/);
  });

  it("fails on a body that is not a key set", async () => {
    const fetcher = async () => Response.json({ keys: [{ kty: "RSA" }] });
    await expect(fetchKeySource("example-team", fetcher as typeof fetch)()).rejects.toThrow();
  });
});
