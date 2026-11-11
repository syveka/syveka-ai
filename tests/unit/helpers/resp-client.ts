import net from "node:net";

// ── Minimal RESP2 client (test-only; avoids adding a Redis dependency) ──
export type Reply = string | number | null | Reply[] | Error;
export class RespClient {
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
