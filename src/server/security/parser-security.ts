import "server-only";

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { MAX_EXTRACTED_CHARS } from "@/server/security/document-ingestion";

export const PARSER_TIMEOUT_MS = 20_000;
export const MAX_PARSER_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 2_000;
export const MAX_DOCX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_DOCX_ENTRY_BYTES = 20 * 1024 * 1024;
export const MAX_DOCX_COMPRESSION_RATIO = 200;
export const MAX_PDF_PAGES = 2_000;

type ParserErrorCode =
  | "parser_timeout"
  | "parser_aborted"
  | "parser_input_limit"
  | "parser_output_limit"
  | "parser_resource_limit"
  | "invalid_docx_archive"
  | "docx_entry_limit"
  | "docx_decompressed_size"
  | "docx_compression_ratio"
  | "pdf_page_limit"
  | "parser_failed";

export class ParserSecurityError extends Error {
  constructor(
    public readonly code: ParserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ParserSecurityError";
  }
}

type WorkerMessage =
  { ok: true; text: string } | { ok: false; code: ParserErrorCode; message: string };

export type ParserWorkerLike = Pick<Worker, "once" | "removeAllListeners" | "terminate">;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

function fail(code, message) {
  parentPort.postMessage({ ok: false, code, message });
}

(async () => {
  try {
    const buffer = Buffer.from(workerData.input);
    let text;
    if (workerData.mimeType === "application/pdf") {
      const loaded = require(workerData.pdfParsePath);
      const pdfParse = loaded.default || loaded;
      const result = await pdfParse(buffer, { max: workerData.maxPdfPages + 1 });
      if (result.numpages > workerData.maxPdfPages) {
        return fail("pdf_page_limit", "PDF exceeds the page limit");
      }
      text = result.text;
    } else {
      const mammoth = require(workerData.mammothPath);
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    }
    if (typeof text !== "string") return fail("parser_failed", "Parser returned invalid output");
    if (text.length > workerData.maxOutputChars) {
      return fail("parser_output_limit", "Parser output exceeds the character limit");
    }
    parentPort.postMessage({ ok: true, text });
  } catch (error) {
    fail("parser_failed", error instanceof Error ? error.message.slice(0, 300) : "Parser failed");
  }
})();
`;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

/** Inspect ZIP metadata without inflating any entry. ZIP64 is rejected fail-closed. */
export function validateDocxArchive(buffer: Buffer): void {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) {
    throw new ParserSecurityError("invalid_docx_archive", "DOCX has no valid ZIP directory");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ParserSecurityError("invalid_docx_archive", "ZIP64 DOCX archives are not supported");
  }
  if (entryCount > MAX_DOCX_ENTRIES) {
    throw new ParserSecurityError("docx_entry_limit", "DOCX contains too many ZIP entries");
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw new ParserSecurityError("invalid_docx_archive", "DOCX central directory is invalid");
  }

  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ParserSecurityError("invalid_docx_archive", "DOCX ZIP entry is invalid");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if ((flags & 0x1) !== 0 || (method !== 0 && method !== 8)) {
      throw new ParserSecurityError("invalid_docx_archive", "DOCX uses unsupported ZIP features");
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new ParserSecurityError("invalid_docx_archive", "ZIP64 DOCX entries are not supported");
    }
    if (uncompressed > MAX_DOCX_ENTRY_BYTES) {
      throw new ParserSecurityError("docx_decompressed_size", "DOCX entry is too large");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_DOCX_DECOMPRESSED_BYTES) {
      throw new ParserSecurityError(
        "docx_decompressed_size",
        "DOCX decompressed size exceeds the limit",
      );
    }
    if (
      uncompressed > 1_048_576 &&
      (compressed === 0 || uncompressed / compressed > MAX_DOCX_COMPRESSION_RATIO)
    ) {
      throw new ParserSecurityError(
        "docx_compression_ratio",
        "DOCX ZIP entry has a suspicious compression ratio",
      );
    }
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;
    if (nextOffset > eocd) {
      throw new ParserSecurityError("invalid_docx_archive", "DOCX ZIP directory is truncated");
    }
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) {
    throw new ParserSecurityError("invalid_docx_archive", "DOCX ZIP directory size does not match");
  }
}

export function assertParserOutput(text: string): void {
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new ParserSecurityError("parser_output_limit", "Parser output exceeds the limit");
  }
}

export async function awaitParserWorker(
  worker: ParserWorkerLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminating = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
      if (error) reject(error);
      else resolve(text ?? "");
    };
    const stop = (error?: Error, text?: string) => {
      if (settled || terminating) return;
      terminating = true;
      void worker.terminate().finally(() => finish(error, text));
    };
    const abort = () => stop(new ParserSecurityError("parser_aborted", "Parser canceled"));
    const timeout = setTimeout(
      () => stop(new ParserSecurityError("parser_timeout", "Parser timed out")),
      timeoutMs,
    );
    worker.once("message", (message: WorkerMessage) => {
      if (!message.ok) {
        stop(new ParserSecurityError(message.code, message.message));
        return;
      }
      try {
        assertParserOutput(message.text);
        stop(undefined, message.text);
      } catch (error) {
        stop(error as Error);
      }
    });
    worker.once("error", () =>
      stop(new ParserSecurityError("parser_resource_limit", "Parser worker failed")),
    );
    worker.once("exit", (code) => {
      if (!settled && !terminating && code !== 0) {
        finish(new ParserSecurityError("parser_resource_limit", "Parser worker exited"));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function parseDocumentIsolated(
  buffer: Buffer,
  mimeType:
    "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  signal?: AbortSignal,
): Promise<string> {
  if (buffer.length > MAX_PARSER_INPUT_BYTES) {
    throw new ParserSecurityError("parser_input_limit", "Parser input exceeds the limit");
  }
  if (mimeType.includes("wordprocessingml")) validateDocxArchive(buffer);

  const transferable = Uint8Array.from(buffer);
  const require = createRequire(import.meta.url);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      input: transferable.buffer,
      mimeType,
      maxOutputChars: MAX_EXTRACTED_CHARS,
      maxPdfPages: MAX_PDF_PAGES,
      pdfParsePath: require.resolve("pdf-parse"),
      mammothPath: require.resolve("mammoth"),
    },
    transferList: [transferable.buffer],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });
  return awaitParserWorker(worker, PARSER_TIMEOUT_MS, signal);
}
