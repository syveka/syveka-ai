import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_JOB_OUTPUT_BYTES = 1024 * 1024 * 1024;
/** Exactly what the worker's naming produces, so a header can't name anything else. */
const SAFE_OUTPUT_NAME =
  /^[a-z0-9][a-z0-9-]{0,47}-\d{1,2}-[a-z-]+-(fi|en|ar)-(9x16|1x1|16x9)\.mp4$/;
const MAX_HEADER_BYTES = 256;
/** Everything that isn't file content, for the whole stream: headers and the one result. */
const MAX_NON_FILE_BYTES = 1024 * 1024;
/** The worker's codes (src/errors.mjs). Anything else is reported as malformed. */
const KNOWN_ERROR_CODES = new Set([
  "invalid_job",
  "invalid_media",
  "media_not_found",
  "render_failed",
  "quality_check_failed",
  "output_invalid",
  "render_timeout",
  "internal_error",
]);
const SAFE_TEXT = /^[a-z0-9_.-]{1,20}$/i;
const FIELD_PATH = /^[\w.]{0,80}$/;

/**
 * The file name the worker gives each render, computed here from the job the host sent, so a
 * stream can only deliver what was asked for. Must match the name built in src/main.mjs.
 * @param {any} job
 * @returns {string[] | null} null when the job can't be read; the worker will reject it.
 */
export function expectedOutputNames(job) {
  if (typeof job?.jobId !== "string" || !Array.isArray(job?.renders)) return null;
  const names = job.renders.map(
    (/** @type {any} */ spec, /** @type {number} */ index) =>
      `${job.jobId}-${index}-${spec?.template}-${spec?.language}-${String(spec?.aspectRatio).replace(":", "x")}.mp4`,
  );
  return names.every((/** @type {string} */ name) => SAFE_OUTPUT_NAME.test(name)) ? names : null;
}

/**
 * Keeps only finite numbers and short plain strings, for the given keys. These values come from
 * inside the container, so they are reported as the worker's claims and must never drive billing
 * or records: nothing nested survives, and nothing here can make a render count as verified.
 * @param {any} source
 * @param {string[]} keys
 */
function claimedValues(source, keys) {
  /** @type {Record<string, number | string>} */
  const kept = {};
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
    else if (typeof value === "string" && SAFE_TEXT.test(value)) kept[key] = value;
  }
  return kept;
}

/** @param {any} error */
function safeError(error) {
  const code = KNOWN_ERROR_CODES.has(error?.code) ? error.code : "output_malformed";
  const fields = Array.isArray(error?.fields)
    ? error.fields
        .filter((/** @type {unknown} */ f) => typeof f === "string" && FIELD_PATH.test(f))
        .slice(0, 50)
    : undefined;
  return { code, ...(fields ? { fields } : {}) };
}

/**
 * Reads the worker's stdout on the host. The container could be compromised, so everything here
 * is untrusted. A stream can only deliver the job's expected files, each once, at limited size,
 * into new files, with one result at the very end. A file passing this is still
 * attacker-influenced media: a consumer must treat it as untrusted.
 */
export class WorkerOutputReader {
  /**
   * @param {string} outputDir
   * @param {string[] | null} [expectedNames] Null when the job couldn't be read: nothing can succeed.
   */
  constructor(outputDir, expectedNames = null) {
    this.outputDir = outputDir;
    this.expectedNames = expectedNames;
    this.buffer = Buffer.alloc(0);
    this.totalBytes = 0;
    this.nonFileBytes = 0;
    /** @type {null | { name: string, size: number, remaining: number, fd: number, hash: import("node:crypto").Hash, partPath: string }} */
    this.current = null;
    /** @type {Map<string, { hash: string, size: number }>} */
    this.files = new Map();
    /** @type {any} */
    this.result = null;
    this.resultSeen = false;
    /** @type {string | null} */
    this.failure = null;
    this.cleanupFailed = false;
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
    this.abort();
  }

  /**
   * Removes everything this job wrote, including anything half-written, and refuses any further
   * data. Never throws: this runs from stream and timer callbacks, where a throw would take the
   * host down. A removal that fails is reported through `finish`.
   */
  abort() {
    this.failure ??= "output_aborted";
    const current = this.current;
    this.current = null;
    if (current) {
      try {
        closeSync(current.fd);
      } catch {
        this.cleanupFailed = true;
      }
      this.removeFile(current.partPath);
    }
    for (const name of this.files.keys()) this.removeFile(join(this.outputDir, name));
    this.files.clear();
    this.buffer = Buffer.alloc(0);
  }

  /** @param {string} path */
  removeFile(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      this.cleanupFailed = true;
    }
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
        if (this.current.remaining === 0) this.completeFile();
        continue;
      }
      if (this.resultSeen) throw new Error("output_malformed");
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.nonFileBytes + this.buffer.length > MAX_NON_FILE_BYTES) {
          throw new Error("output_header_too_long");
        }
        return;
      }
      this.nonFileBytes += newline + 1;
      if (this.nonFileBytes > MAX_NON_FILE_BYTES) throw new Error("output_header_too_long");
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.startsWith("RESULT ")) {
        this.result = JSON.parse(line.slice("RESULT ".length));
        this.resultSeen = true;
      } else {
        this.openFile(line);
      }
    }
  }

  completeFile() {
    const current = /** @type {NonNullable<typeof this.current>} */ (this.current);
    // Cleared first, so a failure below can't close the same descriptor twice.
    this.current = null;
    closeSync(current.fd);
    try {
      renameSync(current.partPath, join(this.outputDir, current.name));
    } catch (error) {
      this.removeFile(current.partPath);
      throw error;
    }
    this.files.set(current.name, { hash: current.hash.digest("hex"), size: current.size });
  }

  /** @param {string} header */
  openFile(header) {
    if (header.length > MAX_HEADER_BYTES) throw new Error("output_header_too_long");
    const match = /^FILE (\S+) (\d+)$/.exec(header);
    if (!match) throw new Error("output_malformed");
    const name = /** @type {string} */ (match[1]);
    const size = Number(match[2]);
    if (!SAFE_OUTPUT_NAME.test(name)) throw new Error("output_name_refused");
    // Without a readable job nothing is expected, so nothing is accepted.
    if (!this.expectedNames?.includes(name)) throw new Error("output_name_refused");
    if (this.files.has(name)) throw new Error("output_name_refused");
    if (!(size > 0) || size > MAX_FILE_BYTES) throw new Error("output_too_large");
    this.totalBytes += size;
    if (this.totalBytes > MAX_JOB_OUTPUT_BYTES) throw new Error("output_too_large");
    const finalPath = join(this.outputDir, name);
    if (existsSync(finalPath)) throw new Error("output_name_refused");
    // Under a working name until complete, so nothing partial ever carries a final file name.
    const partPath = `${finalPath}.part`;
    const fd = openSync(partPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    this.current = { name, size, remaining: size, fd, hash: createHash("sha256"), partPath };
  }

  /**
   * The outcome, decided here. Each of the job's renders must report once, in order, under its
   * expected name, with the size and hash of the bytes that actually arrived. Files no verified
   * render claims are deleted, so a directory never holds more than the result says.
   */
  finish() {
    if (!this.failure && this.current) this.fail("output_truncated");
    if (this.failure) {
      return {
        ok: false,
        error: { code: this.cleanupFailed ? "output_cleanup_failed" : this.failure },
      };
    }
    const claimed = this.result;
    if (claimed === null || typeof claimed !== "object") {
      this.abort();
      return { ok: false, error: { code: "output_truncated" } };
    }
    const expected = this.expectedNames;
    if (claimed.results === undefined && claimed.ok === false) {
      this.abort();
      return { ok: false, error: safeError(claimed.error) };
    }
    if (
      !expected ||
      !Array.isArray(claimed.results) ||
      claimed.results.length !== expected.length
    ) {
      this.abort();
      return { ok: false, error: { code: "output_malformed" } };
    }

    const results = expected.map((name, index) => {
      const item = claimed.results[index];
      if (item?.index !== index) {
        return { index, ok: false, error: { code: "output_unverified" } };
      }
      if (item.ok !== true) return { index, ok: false, error: safeError(item.error) };
      const file = this.files.get(name);
      if (
        !file ||
        item.file !== name ||
        item.sha256 !== file.hash ||
        item.sizeBytes !== file.size
      ) {
        return { index, ok: false, error: { code: "output_unverified" } };
      }
      return {
        index,
        ok: true,
        hostVerified: true,
        file: name,
        sha256: file.hash,
        sizeBytes: file.size,
        workerClaims: {
          video: claimedValues(item.video, [
            "codec",
            "pixelFormat",
            "width",
            "height",
            "fps",
            "durationSeconds",
            "frames",
          ]),
          timings: claimedValues(item.timings, ["prepareMs", "checkMs", "renderMs"]),
          attempts: claimedValues(item, ["attempts"]).attempts ?? null,
          processesAfter: claimedValues(item, ["processesAfter"]).processesAfter ?? null,
        },
      };
    });

    const verified = new Set(results.filter((item) => item.ok).map((item) => item.file));
    for (const name of this.files.keys()) {
      if (!verified.has(name)) this.removeFile(join(this.outputDir, name));
    }
    if (this.cleanupFailed) return { ok: false, error: { code: "output_cleanup_failed" } };
    return {
      ok: results.length > 0 && results.every((item) => item.ok),
      results,
      workerClaims: {
        usage: claimedValues(claimed.usage, [
          "memoryPeakBytes",
          "pidsPeak",
          "pidsCurrent",
          "cpuSeconds",
        ]),
      },
    };
  }
}
