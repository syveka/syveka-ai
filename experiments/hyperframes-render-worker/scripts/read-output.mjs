import { createHash } from "node:crypto";
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_JOB_OUTPUT_BYTES = 1024 * 1024 * 1024;
/** Exactly what the worker's naming produces, so a header can't name anything else. */
const SAFE_OUTPUT_NAME =
  /^[a-z0-9][a-z0-9-]{0,47}-\d{1,2}-[a-z-]+-(fi|en|ar)-(9x16|1x1|16x9)\.mp4$/;
const MAX_HEADER_BYTES = 256;
const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * Reads the worker's stdout on the host. The container could be compromised, so everything here is
 * untrusted: names are checked against one pattern, each file and the job have size limits, files
 * are only ever created new in `outputDir`, and hashes are computed here rather than believed. A
 * file passing this is still attacker-influenced media: a consumer must treat it as untrusted.
 */
export class WorkerOutputReader {
  /** @param {string} outputDir */
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.buffer = Buffer.alloc(0);
    this.totalBytes = 0;
    /** @type {null | { name: string, remaining: number, fd: number, hash: import("node:crypto").Hash, path: string }} */
    this.current = null;
    /** @type {Map<string, string>} */
    this.hashes = new Map();
    /** @type {any} */
    this.result = null;
    this.failure = null;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    if (this.failure) return;
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
    } catch (error) {
      const { message } = /** @type {Error} */ (error);
      this.fail(message.startsWith("output_") ? message : "output_malformed");
    }
  }

  /** @param {string} code */
  fail(code) {
    this.failure = code;
    if (this.current) {
      closeSync(this.current.fd);
      rmSync(this.current.path, { force: true });
      this.current = null;
    }
    this.buffer = Buffer.alloc(0);
  }

  drain() {
    while (this.buffer.length > 0) {
      if (this.current) {
        const take = Math.min(this.current.remaining, this.buffer.length);
        const part = this.buffer.subarray(0, take);
        // writeSync can write less than it was given, so everything hashed is really on disk.
        for (let written = 0; written < part.length;) {
          written += writeSync(this.current.fd, part, written);
        }
        this.current.hash.update(part);
        this.current.remaining -= take;
        this.buffer = this.buffer.subarray(take);
        if (this.current.remaining === 0) {
          closeSync(this.current.fd);
          this.hashes.set(this.current.name, this.current.hash.digest("hex"));
          this.current = null;
        }
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.buffer.length > MAX_RESULT_BYTES) throw new Error("output_header_too_long");
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.startsWith("RESULT ")) {
        this.result = JSON.parse(line.slice("RESULT ".length));
      } else {
        this.openFile(line);
      }
    }
  }

  /** @param {string} header */
  openFile(header) {
    if (header.length > MAX_HEADER_BYTES) throw new Error("output_header_too_long");
    const match = /^FILE (\S+) (\d+)$/.exec(header);
    if (!match) throw new Error("output_malformed");
    const name = /** @type {string} */ (match[1]);
    const size = Number(match[2]);
    if (!SAFE_OUTPUT_NAME.test(name)) throw new Error("output_name_refused");
    if (!(size > 0) || size > MAX_FILE_BYTES) throw new Error("output_too_large");
    this.totalBytes += size;
    if (this.totalBytes > MAX_JOB_OUTPUT_BYTES) throw new Error("output_too_large");
    const path = join(this.outputDir, name);
    // O_EXCL: never overwrites, and never follows a link already at that path.
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    this.current = { name, remaining: size, fd, hash: createHash("sha256"), path };
  }

  /**
   * The outcome, decided here. A claim from the worker counts only where this reader saw the same
   * bytes: a render is verified if its file arrived and its hash matches, and only known-shape
   * fields are passed on, so a forged result can't claim success or smuggle in a path.
   * @param {number | null} [expectedRenders]
   */
  finish(expectedRenders = null) {
    if (!this.failure && this.current) this.fail("output_truncated");
    if (this.failure) return { ok: false, error: { code: this.failure } };
    const claimed = this.result;
    if (claimed === null || typeof claimed !== "object") {
      return { ok: false, error: { code: "output_truncated" } };
    }
    if (claimed.results === undefined && claimed.ok === false) {
      return { ok: false, error: safeError(claimed.error) };
    }
    if (!Array.isArray(claimed.results)) return { ok: false, error: { code: "output_malformed" } };
    const results = claimed.results.map(safeItem(this.hashes));
    const complete =
      results.length > 0 && (expectedRenders === null || results.length === expectedRenders);
    return {
      ok: complete && results.every((/** @type {any} */ item) => item.hostVerified === true),
      results,
      usage: typeof claimed.usage === "object" ? claimed.usage : null,
    };
  }
}

const SAFE_CODE = /^[a-z_]{1,40}$/;

/** @param {any} error */
function safeError(error) {
  const code = typeof error?.code === "string" && SAFE_CODE.test(error.code);
  const fields = Array.isArray(error?.fields)
    ? error.fields.filter(
        (/** @type {unknown} */ f) => typeof f === "string" && /^[\w.]{0,80}$/.test(f),
      )
    : undefined;
  return {
    code: code ? error.code : "output_malformed",
    ...(fields ? { fields } : {}),
  };
}

/** @param {Map<string, string>} hashes */
function safeItem(hashes) {
  return (/** @type {any} */ item) => {
    const index = Number.isInteger(item?.index) ? item.index : null;
    if (item?.ok !== true) return { index, ok: false, error: safeError(item?.error) };
    const file = typeof item.file === "string" && hashes.has(item.file) ? item.file : null;
    const verified =
      file !== null && typeof item.sha256 === "string" && hashes.get(file) === item.sha256;
    if (!verified) return { index, ok: false, error: { code: "output_unverified" } };
    return {
      index,
      ok: true,
      hostVerified: true,
      file,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      video: item.video,
      timings: item.timings,
      attempts: item.attempts,
      processesAfter: item.processesAfter,
    };
  };
}
