import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECIDE_ACTION_SCRIPT, PROPOSE_ACTION_SCRIPT } from "@/server/ai/tool-actions";

/**
 * The pending-action Lua scripts against a REAL Redis server. Opt-in: runs
 * only when VOICE_REDIS_TEST_URL points at an isolated, disposable local
 * Redis (the same one the live-voice script tests use). Never point it at
 * a shared, staging or production instance. Keys use a random per-run
 * namespace and only those keys are deleted afterwards.
 */
const URL_ = process.env.VOICE_REDIS_TEST_URL;

type Reply = string | number | null | Reply[] | Error;
class Resp {
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private queue: Array<(r: Reply) => void> = [];
  readonly ready: Promise<void>;
  constructor(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const p = this.parse(0);
        if (!p) break;
        this.buf = this.buf.subarray(p.next);
        this.queue.shift()?.(p.value);
      }
    });
  }
  private parse(at: number): { value: Reply; next: number } | null {
    const eol = this.buf.indexOf("\r\n", at);
    if (eol < 0) return null;
    const type = String.fromCharCode(this.buf[at]!);
    const line = this.buf.toString("utf8", at + 1, eol);
    if (type === "+") return { value: line, next: eol + 2 };
    if (type === "-") return { value: new Error(line), next: eol + 2 };
    if (type === ":") return { value: Number(line), next: eol + 2 };
    if (type === "$") {
      const len = Number(line);
      if (len < 0) return { value: null, next: eol + 2 };
      if (this.buf.length < eol + 4 + len) return null;
      return { value: this.buf.toString("utf8", eol + 2, eol + 2 + len), next: eol + 4 + len };
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
    const reply = await new Promise<Reply>((resolve) => {
      this.queue.push(resolve);
      this.socket.write(payload);
    });
    if (reply instanceof Error) throw reply;
    return reply;
  }
  close() {
    this.socket.destroy();
  }
}

describe.skipIf(!URL_)("pending-action scripts on a real Redis server", () => {
  const ns = `atest:${crypto.randomUUID()}`;
  const pool: Resp[] = [];
  const ORG = "org-a";
  const USER = "user-1";
  const CONV = "conv-1";
  const NOW = 1_800_000_000_000;
  const evalOn = (c: Resp, script: string, key: string, args: string[]) =>
    c.cmd("EVAL", script, "1", key, ...args);
  const propose = (key: string, digest = "d1", expiresAt = NOW + 600_000) =>
    evalOn(pool[0]!, PROPOSE_ACTION_SCRIPT, key, [
      ORG,
      USER,
      CONV,
      "bookMeeting",
      '{"title":"Demo"}',
      digest,
      String(expiresAt),
      "600",
    ]);
  const decide = (
    key: string,
    o: Partial<{ org: string; user: string; conv: string; digest: string; now: number }> = {},
    client = pool[0]!,
  ) =>
    evalOn(client, DECIDE_ACTION_SCRIPT, key, [
      o.org ?? ORG,
      o.user ?? USER,
      o.conv ?? CONV,
      o.digest ?? "d1",
      "confirmed",
      String(o.now ?? NOW + 1_000),
    ]);

  beforeAll(async () => {
    const url = new URL(URL_!);
    for (let i = 0; i < 6; i++) pool.push(new Resp(url.hostname, Number(url.port || 6379)));
    await Promise.all(pool.map((c) => c.ready));
  });
  afterAll(async () => {
    const [, keys] = (await pool[0]!.cmd("SCAN", "0", "MATCH", `${ns}:*`, "COUNT", "1000")) as [
      string,
      string[],
    ];
    if (keys.length) await pool[0]!.cmd("DEL", ...keys);
    pool.forEach((c) => c.close());
  });

  it("stores a pending action with an expiry; an existing id is never overwritten", async () => {
    const key = `${ns}:a1`;
    expect(await propose(key)).toBe(1);
    expect(await propose(key, "other")).toBe(0);
    const ttl = Number(await pool[0]!.cmd("TTL", key));
    expect(ttl).toBeGreaterThan(590);
    expect(await pool[0]!.cmd("HGET", key, "digest")).toBe("d1");
  });

  it("decides once: concurrent confirmations, exactly one gets the stored action", async () => {
    const key = `${ns}:a2`;
    await propose(key);
    const results = (await Promise.all(pool.map((c) => decide(key, {}, c)))) as Reply[][];
    const won = results.filter((r) => r[0] === 1);
    expect(won).toHaveLength(1);
    expect(won[0]).toEqual([1, "bookMeeting", '{"title":"Demo"}']);
    expect(results.filter((r) => r[0] === -3)).toHaveLength(pool.length - 1);
  });

  it("another org, user or conversation sees nothing, and the action stays pending", async () => {
    const key = `${ns}:a3`;
    await propose(key);
    expect(await decide(key, { org: "org-b" })).toEqual([-1]);
    expect(await decide(key, { user: "user-2" })).toEqual([-1]);
    expect(await decide(key, { conv: "conv-2" })).toEqual([-1]);
    expect(await pool[0]!.cmd("HGET", key, "status")).toBe("pending");
    expect((await decide(key)) as Reply[]).toHaveLength(3);
  });

  it("a different digest (another action or changed arguments) is refused; it stays pending", async () => {
    const key = `${ns}:a4`;
    await propose(key);
    expect(await decide(key, { digest: "d2" })).toEqual([-4]);
    expect(await pool[0]!.cmd("HGET", key, "status")).toBe("pending");
  });

  it("expired (by time or by key expiry) and unknown actions are refused", async () => {
    const key = `${ns}:a5`;
    await propose(key, "d1", NOW + 10);
    expect(await decide(key, { now: NOW + 10 })).toEqual([-1]);
    expect(await decide(`${ns}:missing`)).toEqual([-1]);
  });
});
