import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireCallSlot,
  CALL_SLOT_TTL_MS,
  releaseCallSlot,
  type SlotClient,
} from "@/server/voice/call-slots";
import { RespClient } from "./helpers/resp-client";

/**
 * Call slots on a REAL Redis server, not an emulator. Opt-in: runs only when
 * VOICE_REDIS_TEST_URL points at an isolated, disposable local Redis. Never point it at a
 * shared, staging or production instance. Keys live under a random namespace per run, and
 * several connections make the script calls really interleave at the server.
 */
const URL_ = process.env.VOICE_REDIS_TEST_URL;
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-20T12:00:00Z");

describe.skipIf(!URL_)("voice call slots on a real Redis server", () => {
  const pool: RespClient[] = [];
  let admin: RespClient;
  const namespace = `test:slots:${randomUUID()}`;
  let next = 0;

  /** A client for one test, with its own namespace, taking turns over the connections. */
  function client(): SlotClient {
    const keyPrefix = `${namespace}:${randomUUID()}`;
    return {
      keyPrefix,
      eval: (script, keys, args) =>
        pool[next++ % pool.length]!.cmd(
          "EVAL",
          script,
          String(keys.length),
          ...keys,
          ...args,
        ) as Promise<unknown>,
    };
  }

  beforeAll(async () => {
    const url = new URL(URL_ as string);
    const connect = async () => {
      const c = new RespClient(url.hostname, Number(url.port));
      await c.ready;
      return c;
    };
    admin = await connect();
    for (let i = 0; i < 8; i++) pool.push(await connect());
  });

  afterAll(async () => {
    const keys = (await admin.cmd("KEYS", `${namespace}:*`)) as string[];
    if (keys.length > 0) await admin.cmd("DEL", ...keys);
    admin.close();
    pool.forEach((c) => c.close());
  });

  it("grants exactly the limit under concurrent requests", async () => {
    const c = client();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => acquireCallSlot(c, ORG_A, `call-${i}`, 3, NOW)),
    );
    const granted = results.filter((r) => r !== null);
    expect(granted).toHaveLength(3);
    expect(granted.map((r) => r?.held).sort()).toEqual([1, 2, 3]);
    expect(granted.every((r) => r?.alreadyHeld === false)).toBe(true);
  });

  it("a retry of the same call under concurrency takes one slot", async () => {
    const c = client();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => acquireCallSlot(c, ORG_A, "same-call", 1, NOW)),
    );
    expect(results.every((r) => r?.held === 1)).toBe(true);
    expect(results.filter((r) => r?.alreadyHeld === false)).toHaveLength(1);
  });

  it("a call already holding a slot is still admitted at the limit", async () => {
    const c = client();
    await acquireCallSlot(c, ORG_A, "first", 1, NOW);
    expect(await acquireCallSlot(c, ORG_A, "first", 1, NOW)).toEqual({
      held: 1,
      alreadyHeld: true,
    });
    expect(await acquireCallSlot(c, ORG_A, "second", 1, NOW)).toBeNull();
  });

  it("one organization at its limit never affects another, under concurrency", async () => {
    const c = client();
    const [a, b] = await Promise.all([
      Promise.all(
        Array.from({ length: 50 }, (_, i) => acquireCallSlot(c, ORG_A, `a-${i}`, 1, NOW)),
      ),
      Promise.all(
        Array.from({ length: 50 }, (_, i) => acquireCallSlot(c, ORG_B, `b-${i}`, 2, NOW)),
      ),
    ]);
    expect(a.filter((r) => r !== null)).toHaveLength(1);
    expect(b.filter((r) => r !== null)).toHaveLength(2);
  });

  it("the same call id in another organization is a separate slot", async () => {
    const c = client();
    expect((await acquireCallSlot(c, ORG_A, "shared-id", 1, NOW))?.held).toBe(1);
    expect((await acquireCallSlot(c, ORG_B, "shared-id", 1, NOW))?.alreadyHeld).toBe(false);
    await releaseCallSlot(c, ORG_A, "shared-id");
    expect(await acquireCallSlot(c, ORG_B, "other", 1, NOW)).toBeNull();
  });

  it("asking with a limit of zero takes nothing, and reports a slot already held", async () => {
    const c = client();
    expect(await acquireCallSlot(c, ORG_A, "new", 0, NOW)).toBeNull();
    await acquireCallSlot(c, ORG_A, "held", 1, NOW);
    expect(await acquireCallSlot(c, ORG_A, "held", 0, NOW)).toEqual({
      held: 1,
      alreadyHeld: true,
    });
  });

  it("refuses everything at a limit of zero", async () => {
    expect(await acquireCallSlot(client(), ORG_A, "call", 0, NOW)).toBeNull();
  });

  it("releasing frees a slot, and releasing twice is harmless", async () => {
    const c = client();
    await acquireCallSlot(c, ORG_A, "first", 1, NOW);
    await releaseCallSlot(c, ORG_A, "first");
    await releaseCallSlot(c, ORG_A, "first");
    await releaseCallSlot(c, ORG_A, "never-held");
    expect((await acquireCallSlot(c, ORG_A, "second", 1, NOW))?.held).toBe(1);
  });

  it("a slot lost to a crash expires by itself", async () => {
    const c = client();
    await acquireCallSlot(c, ORG_A, "crashed", 1, NOW);
    const justBefore = new Date(NOW.getTime() + CALL_SLOT_TTL_MS - 1);
    expect(await acquireCallSlot(c, ORG_A, "too-soon", 1, justBefore)).toBeNull();
    const after = new Date(NOW.getTime() + CALL_SLOT_TTL_MS);
    expect((await acquireCallSlot(c, ORG_A, "later", 1, after))?.held).toBe(1);
  });

  it("the key itself expires, so idle organizations leave nothing behind", async () => {
    const c = client();
    await acquireCallSlot(c, ORG_A, "call", 1, NOW);
    const ttl = (await admin.cmd("PTTL", `${c.keyPrefix}:${ORG_A}`)) as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CALL_SLOT_TTL_MS);
  });
});
