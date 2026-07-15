import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { MAX_EXTRACTED_CHARS } from "@/server/security/document-ingestion";
import {
  assertParserOutput,
  awaitParserWorker,
  MAX_DOCX_DECOMPRESSED_BYTES,
  MAX_DOCX_ENTRIES,
  validateDocxArchive,
} from "@/server/security/parser-security";

type ZipEntry = { compressed: number; uncompressed: number };

function zipDirectory(entries: ZipEntry[], declaredEntryCount = entries.length): Buffer {
  const central = entries.map(({ compressed, uncompressed }) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(compressed, 20);
    header.writeUInt32LE(uncompressed, 24);
    return header;
  });
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(declaredEntryCount, 8);
  eocd.writeUInt16LE(declaredEntryCount, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralBuffer, eocd]);
}

describe("DOCX ZIP preflight", () => {
  it("rejects oversized total decompression before parsing", () => {
    const half = Math.floor(MAX_DOCX_DECOMPRESSED_BYTES / 2);
    expect(() =>
      validateDocxArchive(
        zipDirectory([
          { compressed: half, uncompressed: half },
          { compressed: half, uncompressed: half },
          { compressed: 2, uncompressed: 2 },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "docx_decompressed_size" }));
  });

  it("rejects excessive ZIP entry counts before walking entries", () => {
    expect(() => validateDocxArchive(zipDirectory([], MAX_DOCX_ENTRIES + 1))).toThrowError(
      expect.objectContaining({ code: "docx_entry_limit" }),
    );
  });

  it("rejects suspicious compression ratios", () => {
    expect(() =>
      validateDocxArchive(zipDirectory([{ compressed: 1, uncompressed: 2 * 1024 * 1024 }])),
    ).toThrowError(expect.objectContaining({ code: "docx_compression_ratio" }));
  });
});

describe("isolated parser enforcement", () => {
  it("rejects excessive parser output", () => {
    expect(() => assertParserOutput("x".repeat(MAX_EXTRACTED_CHARS + 1))).toThrowError(
      expect.objectContaining({ code: "parser_output_limit" }),
    );
  });

  it("terminates parser work on hard timeout", async () => {
    const worker = new Worker("while (true) {}", { eval: true });
    await expect(awaitParserWorker(worker, 50)).rejects.toMatchObject({ code: "parser_timeout" });
  });

  it("terminates parser work when the caller aborts", async () => {
    const worker = new Worker("while (true) {}", { eval: true });
    const controller = new AbortController();
    const parsing = awaitParserWorker(worker, 5_000, controller.signal);
    controller.abort();
    await expect(parsing).rejects.toMatchObject({ code: "parser_aborted" });
  });
});
