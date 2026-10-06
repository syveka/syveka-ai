import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY_TTL_SECONDS,
  DEFAULT_VOICE_CONVERSATION_CONFIG,
  GRANT_TTL_SECONDS,
  consumeVoiceGrant,
  endVoiceSession,
  hasActiveVoiceSession,
  issueVoiceGrant,
  readVoiceAllowance,
  reserveVoiceTurn,
  startVoiceSession,
  type EvalClient,
  type VoiceConversationConfig,
} from "@/server/ai/voice-conversation";

/**
 * The live-voice Lua scripts and their TypeScript wrappers against a REAL
 * Redis server — not an emulator. Opt-in: runs only when VOICE_REDIS_TEST_URL
 * points at an isolated, disposable local Redis (e.g. redis://127.0.0.1:6390).
 * Never point it at a shared, staging or production instance.
 *
 * Every key lives under a random per-run namespace (EvalClient.keyPrefix),
 * and cleanup deletes only that namespace's keys. Concurrency uses several
 * connections, so script calls genuinely interleave at the server.
 */
const URL_ = process.env.VOICE_REDIS_TEST_URL;

// ── Minimal RESP2 client (test-only; avoids adding a Redis dependency) ──
type Reply = string | number | null | Reply[] | Error;
class RespClient {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private queue: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  readonly ready: Promise<void>;

  constructor(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = this.parse(0);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.next);
        this.queue.shift()?.resolve(parsed.value);
      }
    });
    this.socket.on("error", (e) => this.queue.splice(0).forEach((q) => q.reject(e)));
  }

  private parse(at: number): { value: Reply; next: number } | null {
    const eol = this.buffer.indexOf("\r\n", at);
    if (eol < 0) return null;
    const type = String.fromCharCode(this.buffer[at]!);
    const line = this.buffer.toString("utf8", at + 1, eol);
    if (type === "+") return { value: line, next: eol + 2 };
    if (type === "-") return { value: new Error(line), next: eol + 2 };
    if (type === ":") return { value: Number(line), next: eol + 2 };
    if (type === "$") {
      const len = Number(line);
      if (len < 0) return { value: null, next: eol + 2 };
      if (this.buffer.length < eol + 2 + len + 2) return null;
      return { value: this.buffer.toString("utf8", eol + 2, eol + 2 + len), next: eol + 4 + len };
    }
    if (type === "*") {
      const n = Number(line);
      if (n < 0) return { value: null, next: eol + 2 };
      const items: Reply[] = [];
      let next = eol + 2;
      for (let i = 0; i < n; i++) {
        const item = this.parse(next);
        if (!item) return null;
        items.push(item.value);
        next = item.next;
      }
      return { value: items, next };
    }
    throw new Error(`Unexpected RESP type ${type}`);
  }

  async cmd(...args: string[]): Promise<Reply> {
    const payload =
      `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("");
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.socket.write(payload);
    });
    if (reply instanceof Error) throw reply;
    return reply;
  }

  close() {
    this.socket.destroy();
  }
}

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "44444444-4444-4444-8444-444444444444";
const CONV = "55555555-5555-4555-8555-555555555555";
const CONV_2 = "66666666-6666-4666-8666-666666666666";
const me = { orgId: ORG, userId: USER };

const PILOT: VoiceConversationConfig = { ...DEFAULT_VOICE_CONVERSATION_CONFIG };
const at = (iso: string) => new Date(iso);

describe.skipIf(!URL_)("voice conversation scripts on a real Redis server", () => {
  const namespaces: string[] = [];
  const pool: RespClient[] = [];
  let admin: RespClient;

  /** A client for one test: its own namespace, round-robin over the pool. */
  function store(): EvalClient & { ns: string } {
    const ns = `vtest:${crypto.randomUUID()}`;
    namespaces.push(ns);
    let i = 0;
    return {
      ns,
      keyPrefix: ns,
      eval: (script, keys, args) =>
        pool[i++ % pool.length]!.cmd("EVAL", script, String(keys.length), ...keys, ...args),
    };
  }
  const keysOf = async (ns: string) => {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = (await admin.cmd(
        "SCAN",
        cursor,
        "MATCH",
        `${ns}:*`,
        "COUNT",
        "500",
      )) as [string, string[]];
      cursor = next;
      found.push(...batch);
    } while (cursor !== "0");
    return found;
  };

  beforeAll(async () => {
    const url = new URL(URL_!);
    const host = url.hostname;
    const port = Number(url.port || 6379);
    for (let i = 0; i < 8; i++) pool.push(new RespClient(host, port));
    admin = new RespClient(host, port);
    await Promise.all([...pool, admin].map((c) => c.ready));
    const info = (await admin.cmd("INFO", "server")) as string;
    console.info(`[real redis] ${/redis_version:(\S+)/.exec(info)?.[1] ?? "?"} at ${host}:${port}`);
  });

  afterAll(async () => {
    // Delete only keys this run created (its namespaces).
    for (const ns of namespaces) {
      const keys = await keysOf(ns);
      if (keys.length) await admin.cmd("DEL", ...keys);
    }
    for (const c of [...pool, admin]) c.close();
  });

  it("concurrent session starts: exactly one daily session succeeds", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        startVoiceSession(
          r,
          { orgId: ORG, userId: i % 2 ? USER : OTHER_USER },
          PILOT,
          crypto.randomUUID(),
          { id: CONV, isNew: false },
          now,
        ),
      ),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok).every((x) => !x.ok && x.reason === "daily_sessions")).toBe(
      true,
    );
    const day = (await admin.cmd("GET", `${r.ns}:org:${ORG}:sessions:2026-09-28`)) as string;
    expect(day).toBe("1");
  });

  it("a refused start never ends the user's live session (e.g. a second tab)", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const s1 = crypto.randomUUID();
    expect((await startVoiceSession(r, me, PILOT, s1, { id: CONV, isNew: false }, now)).ok).toBe(
      true,
    );
    const tab2 = await startVoiceSession(
      r,
      me,
      PILOT,
      crypto.randomUUID(),
      { id: CONV, isNew: false },
      now,
    );
    expect(tab2).toEqual({ ok: false, reason: "daily_sessions" });
    expect(await hasActiveVoiceSession(r, me, now)).toBe(true);
    expect((await reserveVoiceTurn(r, me, PILOT, s1, crypto.randomUUID(), 2000, now)).ok).toBe(
      true,
    );
  });

  it("concurrent turn reservations never exceed the daily turn budget (10)", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const config = { ...PILOT, maxTurnsPerSession: 200 };
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, config, s, { id: CONV, isNew: false }, now);
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        reserveVoiceTurn(r, me, config, s, crypto.randomUUID(), 2_000, now),
      ),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(10);
    expect(await admin.cmd("GET", `${r.ns}:org:${ORG}:turns:2026-09-28`)).toBe("10");
    expect(await admin.cmd("GET", `${r.ns}:org:${ORG}:day:2026-09-28`)).toBe("20000");
  });

  it("concurrent turn reservations never exceed the daily audio budget (300 s)", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const config = { ...PILOT, maxTurnsPerSession: 200, dailyOrgTurns: 2000 };
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, config, s, { id: CONV, isNew: false }, now);
    const results = await Promise.all(
      Array.from({ length: 80 }, () =>
        reserveVoiceTurn(r, me, config, s, crypto.randomUUID(), 7_000, now),
      ),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(42); // floor(300 / 7)
    const used = Number(await admin.cmd("GET", `${r.ns}:org:${ORG}:day:2026-09-28`));
    expect(used).toBe(294_000);
    // A new session can't reset it; the refused turn reserved nothing.
    expect(results.filter((x) => !x.ok).every((x) => !x.ok && x.reason === "daily_budget")).toBe(
      true,
    );
    expect(Number(await admin.cmd("GET", `${r.ns}:org:${ORG}:turns:2026-09-28`))).toBe(42);
  });

  it("a grant is consumed exactly once under concurrent requests", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    const grant = (await issueVoiceGrant(r, me, s, crypto.randomUUID(), "Hei", now))!;
    const results = await Promise.all(
      Array.from({ length: 40 }, () => consumeVoiceGrant(r, me, grant, "Hei", CONV, now)),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok && x.reason === "invalid_grant")).toHaveLength(39);
    expect(await admin.cmd("EXISTS", `${r.ns}:grant:${grant}`)).toBe(0);
  });

  it("conversation and ownership binding", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    const grant = (await issueVoiceGrant(r, me, s, crypto.randomUUID(), "Hei", now))!;
    expect(await consumeVoiceGrant(r, me, grant, "Hei", CONV_2, now)).toEqual({
      ok: false,
      reason: "conversation_mismatch",
    });
    expect(
      await consumeVoiceGrant(r, { orgId: ORG, userId: OTHER_USER }, grant, "Hei", CONV, now),
    ).toEqual({ ok: false, reason: "invalid_grant" });
    expect(
      await consumeVoiceGrant(r, { orgId: OTHER_ORG, userId: USER }, grant, "Hei", CONV, now),
    ).toEqual({ ok: false, reason: "invalid_grant" });
    expect(await consumeVoiceGrant(r, me, grant, "Hei!", CONV, now)).toEqual({
      ok: false,
      reason: "message_mismatch",
    });
    // None of the refused attempts used it up.
    expect(await consumeVoiceGrant(r, me, grant, "Hei", CONV, now)).toEqual({
      ok: true,
      newConversation: false,
    });
    // Another user can't reserve turns in (or end) my session.
    const other = { orgId: ORG, userId: OTHER_USER };
    expect(await reserveVoiceTurn(r, other, PILOT, s, crypto.randomUUID(), 1000, now)).toEqual({
      ok: false,
      reason: "session_not_found",
    });
    expect(await endVoiceSession(r, other, s)).toBe("not_owner");
  });

  it("a new chat's reserved conversation is carried to its grants", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const s = crypto.randomUUID();
    const reserved = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: reserved, isNew: true }, now);
    const grant = (await issueVoiceGrant(r, me, s, crypto.randomUUID(), "Hei", now))!;
    expect(await consumeVoiceGrant(r, me, grant, "Hei", reserved, now)).toEqual({
      ok: true,
      newConversation: true,
    });
  });

  it("ended, replaced and expired sessions can't start new work", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const config = { ...PILOT, dailyOrgSessions: 10 };
    // Ended.
    const s1 = crypto.randomUUID();
    await startVoiceSession(r, me, config, s1, { id: CONV, isNew: false }, now);
    const g1 = (await issueVoiceGrant(r, me, s1, crypto.randomUUID(), "a", now))!;
    expect(await endVoiceSession(r, me, s1)).toBe("ended");
    expect(await consumeVoiceGrant(r, me, g1, "a", CONV, now)).toEqual({
      ok: false,
      reason: "session_ended",
    });
    expect(await issueVoiceGrant(r, me, s1, crypto.randomUUID(), "a", now)).toBeNull();
    expect(await hasActiveVoiceSession(r, me, now)).toBe(false);
    // Replaced (same user starts again, slots allowing).
    const s2 = crypto.randomUUID();
    await startVoiceSession(r, me, config, s2, { id: CONV, isNew: false }, now);
    const g2 = (await issueVoiceGrant(r, me, s2, crypto.randomUUID(), "b", now))!;
    await startVoiceSession(r, me, config, crypto.randomUUID(), { id: CONV, isNew: false }, now);
    expect(await consumeVoiceGrant(r, me, g2, "b", CONV, now)).toEqual({
      ok: false,
      reason: "session_ended",
    });
    expect((await reserveVoiceTurn(r, me, config, s2, crypto.randomUUID(), 1000, now)).ok).toBe(
      false,
    );
    // Expired (server-side clock passed the session's end).
    const s3 = crypto.randomUUID();
    const t0 = at("2026-09-28T10:00:00Z");
    await startVoiceSession(r, me, config, s3, { id: CONV, isNew: false }, t0);
    const g3 = (await issueVoiceGrant(r, me, s3, crypto.randomUUID(), "c", t0))!;
    const later = new Date(t0.getTime() + config.sessionSeconds * 1000 + 1);
    expect(await reserveVoiceTurn(r, me, config, s3, crypto.randomUUID(), 1000, later)).toEqual({
      ok: false,
      reason: "session_expired",
    });
    expect(await consumeVoiceGrant(r, me, g3, "c", CONV, later)).toEqual({
      ok: false,
      reason: "session_ended",
    });
    expect(await hasActiveVoiceSession(r, me, later)).toBe(false);
  });

  it("keys carry expiries; an expired grant is gone", async () => {
    const r = store();
    const now = new Date();
    const s = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    await reserveVoiceTurn(r, me, PILOT, s, turnId, 1000, now);
    const grant = (await issueVoiceGrant(r, me, s, turnId, "x", now))!;
    const ttl = async (key: string) => Number(await admin.cmd("TTL", key));
    const day = (await keysOf(r.ns)).find((k) => k.includes(":sessions:"))!;
    expect(await ttl(day)).toBeGreaterThan(DAY_TTL_SECONDS - 60);
    expect(await ttl(day)).toBeLessThanOrEqual(DAY_TTL_SECONDS);
    for (const part of [":day:", ":turns:"]) {
      const key = (await keysOf(r.ns)).find((k) => k.includes(part))!;
      expect(await ttl(key)).toBeGreaterThan(0);
    }
    expect(await ttl(`${r.ns}:session:${s}`)).toBeLessThanOrEqual(PILOT.sessionSeconds + 60);
    expect(await ttl(`${r.ns}:session:${s}`)).toBeGreaterThan(PILOT.sessionSeconds);
    expect(await ttl(`${r.ns}:grant:${grant}`)).toBeLessThanOrEqual(GRANT_TTL_SECONDS);
    expect(await ttl(`${r.ns}:turn:${s}:${turnId}`)).toBeGreaterThan(0);
    // Let Redis expire the grant for real.
    await admin.cmd("PEXPIRE", `${r.ns}:grant:${grant}`, "50");
    await new Promise((res) => setTimeout(res, 150));
    expect(await consumeVoiceGrant(r, me, grant, "x", CONV, now)).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
  });

  it.each([
    ["summer time (EEST)", "2026-09-28T20:59:59Z", "2026-09-28T21:00:00Z"],
    ["DST fall-back day (25 h)", "2026-10-25T21:59:59Z", "2026-10-25T22:00:00Z"],
    ["DST spring-forward day (23 h)", "2026-03-28T21:59:59Z", "2026-03-28T22:00:00Z"],
  ])("Helsinki-day rollover, %s", async (_l, lastSecond, midnight) => {
    const r = store();
    const start = (iso: string) =>
      startVoiceSession(r, me, PILOT, crypto.randomUUID(), { id: CONV, isNew: false }, at(iso));
    expect((await start(lastSecond)).ok).toBe(true);
    const again = await start(lastSecond);
    expect(again).toEqual({ ok: false, reason: "daily_sessions" });
    expect((await start(midnight)).ok).toBe(true);
  });

  it("a request that lost its response can't reserve or generate twice", async () => {
    const r = store();
    const now = at("2026-09-28T09:00:00Z");
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    const turnId = crypto.randomUUID();
    expect((await reserveVoiceTurn(r, me, PILOT, s, turnId, 3_000, now)).ok).toBe(true);
    // The client never saw the answer and retries the same turn.
    expect(await reserveVoiceTurn(r, me, PILOT, s, turnId, 3_000, now)).toEqual({
      ok: false,
      reason: "duplicate_turn",
    });
    expect(await admin.cmd("GET", `${r.ns}:org:${ORG}:turns:2026-09-28`)).toBe("1");
    expect(await admin.cmd("GET", `${r.ns}:org:${ORG}:day:2026-09-28`)).toBe("3000");
    // A chat request whose response was lost: its grant is already spent.
    const grant = (await issueVoiceGrant(r, me, s, turnId, "Hei", now))!;
    expect((await consumeVoiceGrant(r, me, grant, "Hei", CONV, now)).ok).toBe(true);
    expect((await consumeVoiceGrant(r, me, grant, "Hei", CONV, now)).ok).toBe(false);
  });

  it("fails closed when Redis is unreachable (every operation throws)", async () => {
    const dead = new RespClient("127.0.0.1", 1); // nothing listens on port 1
    await dead.ready.catch(() => {});
    const r: EvalClient = {
      keyPrefix: `vtest:${crypto.randomUUID()}`,
      eval: (script, keys, args) =>
        Promise.race([
          dead.cmd("EVAL", script, String(keys.length), ...keys, ...args),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("unreachable")), 1_000),
          ),
        ]),
    };
    const now = new Date();
    await expect(
      startVoiceSession(r, me, PILOT, crypto.randomUUID(), { id: CONV, isNew: false }, now),
    ).rejects.toThrow();
    await expect(
      reserveVoiceTurn(r, me, PILOT, crypto.randomUUID(), crypto.randomUUID(), 1000, now),
    ).rejects.toThrow();
    await expect(consumeVoiceGrant(r, me, crypto.randomUUID(), "x", CONV, now)).rejects.toThrow();
    await expect(hasActiveVoiceSession(r, me, now)).rejects.toThrow();
    dead.close();
  });

  // ── Allowance (read-only) and the reported incident ──

  it("the reported sequence: 6 turns used, a session-only decrement, a new session → 4 turns left; the 5th is refused", async () => {
    const r = store();
    const now = at("2026-09-30T09:00:00Z");
    const s1 = crypto.randomUUID();
    expect((await startVoiceSession(r, me, PILOT, s1, { id: CONV, isNew: false }, now)).ok).toBe(
      true,
    );
    for (let i = 0; i < 6; i++) {
      expect((await reserveVoiceTurn(r, me, PILOT, s1, crypto.randomUUID(), 5_290, now)).ok).toBe(
        true,
      );
    }
    await endVoiceSession(r, me, s1);
    const s2 = crypto.randomUUID();
    expect(await startVoiceSession(r, me, PILOT, s2, { id: CONV, isNew: false }, now)).toEqual({
      ok: false,
      reason: "daily_sessions",
    });
    // The operator's manual, session-only adjustment (in this test's own namespace).
    await admin.cmd("DECR", `${r.ns}:org:${ORG}:sessions:2026-09-30`);
    expect((await startVoiceSession(r, me, PILOT, s2, { id: CONV, isNew: false }, now)).ok).toBe(
      true,
    );
    const before = await readVoiceAllowance(r, me, PILOT, s2, now);
    expect(before.turnsToday).toEqual({ used: 6, limit: 10, remaining: 4 });
    expect(before.audioMsToday.used).toBe(31_740); // milliseconds
    expect(before.session?.turns).toEqual({ used: 0, limit: 10, remaining: 10 });
    expect(before.turnsAvailable).toBe(4); // not the session's 10
    for (let i = 0; i < 4; i++) {
      expect((await reserveVoiceTurn(r, me, PILOT, s2, crypto.randomUUID(), 3_000, now)).ok).toBe(
        true,
      );
    }
    expect(await reserveVoiceTurn(r, me, PILOT, s2, crypto.randomUUID(), 3_000, now)).toEqual({
      ok: false,
      reason: "daily_turns",
    });
    const after = await readVoiceAllowance(r, me, PILOT, s2, now);
    expect(after.turnsToday.used).toBe(10);
    expect(after.audioMsToday.used).toBe(31_740 + 4 * 3_000); // the refusal reserved nothing
    expect(after.turnsAvailable).toBe(0);
  });

  it("reading the allowance changes nothing (no key, value or expiry)", async () => {
    const r = store();
    const now = at("2026-09-30T09:00:00Z");
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    await reserveVoiceTurn(r, me, PILOT, s, crypto.randomUUID(), 4_000, now);
    const snapshot = async () => {
      const keys = (await keysOf(r.ns)).sort();
      const rows: unknown[] = [];
      for (const k of keys) {
        rows.push([k, await admin.cmd("DUMP", k), await admin.cmd("PTTL", k)]);
      }
      return rows;
    };
    const before = await snapshot();
    for (let i = 0; i < 5; i++) {
      await readVoiceAllowance(r, me, PILOT, s, now);
      await readVoiceAllowance(r, me, PILOT, null, now);
    }
    const after = await snapshot();
    // PTTL counts down between snapshots; compare values exactly and expiries to within 5 s.
    expect(after.map((row) => (row as unknown[]).slice(0, 2))).toEqual(
      before.map((row) => (row as unknown[]).slice(0, 2)),
    );
    after.forEach((row, i) => {
      const ttl = Number((row as unknown[])[2]);
      const was = Number((before[i] as unknown[])[2]);
      expect(ttl).toBeLessThanOrEqual(was);
      expect(was - ttl).toBeLessThan(5_000);
    });
  });

  it("another organization reads only its own counters and never another's session", async () => {
    const r = store();
    const now = at("2026-09-30T09:00:00Z");
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    await reserveVoiceTurn(r, me, PILOT, s, crypto.randomUUID(), 4_000, now);
    const other = await readVoiceAllowance(r, { orgId: OTHER_ORG, userId: USER }, PILOT, s, now);
    expect(other.session).toBeNull();
    expect(other.turnsToday.used).toBe(0);
    expect(other.startsToday.used).toBe(0);
    const colleague = await readVoiceAllowance(
      r,
      { orgId: ORG, userId: OTHER_USER },
      PILOT,
      s,
      now,
    );
    expect(colleague.session).toBeNull(); // the session is its owner's
    expect(colleague.turnsToday.used).toBe(1); // the organization's shared daily count
  });

  it("replays of one turn (same id), even concurrent, reserve it once", async () => {
    const r = store();
    const now = at("2026-09-30T09:00:00Z");
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, now);
    const turnId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserveVoiceTurn(r, me, PILOT, s, turnId, 2_000, now)),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok && x.reason === "duplicate_turn")).toHaveLength(11);
    const a = await readVoiceAllowance(r, me, PILOT, s, now);
    expect([a.turnsToday.used, a.audioMsToday.used, a.session?.turns.used]).toEqual([1, 2_000, 1]);
  });

  it("the daily counts renew at Helsinki midnight (a session crossing it uses the new day)", async () => {
    const r = store();
    const late = at("2026-09-30T20:59:00Z"); // 23:59 in Helsinki
    const s = crypto.randomUUID();
    await startVoiceSession(r, me, PILOT, s, { id: CONV, isNew: false }, late);
    for (let i = 0; i < 10; i++) {
      await reserveVoiceTurn(r, me, PILOT, s, crypto.randomUUID(), 1_000, late);
    }
    const before = await readVoiceAllowance(r, me, PILOT, s, late);
    expect(before.turnsAvailable).toBe(0);
    expect(new Date(before.renewsAt).toISOString()).toBe("2026-09-30T21:00:00.000Z");
    const next = at("2026-09-30T21:00:01Z"); // 00:00:01 on 1 October
    const after = await readVoiceAllowance(r, me, PILOT, s, next);
    expect(after.day).toBe("2026-10-01");
    expect(after.turnsToday.remaining).toBe(10);
    expect(after.startsToday.remaining).toBe(1);
    // The session's own cap still applies (10 already used in it).
    expect(after.turnsAvailable).toBe(0);
    expect((await reserveVoiceTurn(r, me, PILOT, s, crypto.randomUUID(), 1_000, next)).ok).toBe(
      false,
    );
  });
});
