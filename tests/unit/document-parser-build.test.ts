import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseDocumentIsolated, resolveParserPaths } from "@/server/security/parser-security";
import { makeTextDocx, makeTextPdf } from "./helpers/document-files";

/**
 * Checks the production build, not the source: run after `npm run build` with
 * DOCUMENT_PARSER_BUILD_TEST=1. The parsers are required by path inside a
 * worker thread, which neither webpack nor the build's file tracing can see,
 * so only the built output shows whether a deployment can load them.
 */
const ENABLED = process.env.DOCUMENT_PARSER_BUILD_TEST === "1";

const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, ".next", "server");
/** The routes whose bundles include the document parser. */
const PARSER_ROUTES = ["api/v1/jobs/embed-document", "api/v1/business-dna/extract"];
const PDF_PARSE_FILES = [
  "node_modules/pdf-parse/package.json",
  "node_modules/pdf-parse/lib/pdf-parse.js",
  "node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js",
  "node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.worker.js",
];

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/** Repository-relative paths (posix) of every file in a route's trace. */
function tracedFiles(route: string): Set<string> {
  const traceFile = path.join(SERVER_DIR, "app", ...route.split("/"), "route.js.nft.json");
  const trace = JSON.parse(readFileSync(traceFile, "utf8")) as { files: string[] };
  const routeDir = path.dirname(traceFile);
  return new Set(
    trace.files.map((file) =>
      toPosix(path.relative(ROOT, path.resolve(routeDir, file.replace(/\\/g, "/")))),
    ),
  );
}

type LockPackage = { dependencies?: Record<string, string>; optionalDependencies?: object };

/** pdf-parse, mammoth and every production dependency below them, as lockfile locations. */
function parserDependencyClosure(): string[] {
  const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, LockPackage>;
  };
  const locate = (from: string, name: string): string => {
    let base = from;
    for (;;) {
      const candidate = `${base}/node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      const parent = base.lastIndexOf("/node_modules/");
      if (parent < 0) break;
      base = base.slice(0, parent);
    }
    if (lock.packages[`node_modules/${name}`]) return `node_modules/${name}`;
    throw new Error(`${name} (needed by ${from}) is not in package-lock.json`);
  };
  const found = new Set<string>();
  const pending = ["node_modules/pdf-parse", "node_modules/mammoth"];
  while (pending.length > 0) {
    const location = pending.pop()!;
    if (found.has(location)) continue;
    found.add(location);
    const entry = lock.packages[location]!;
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      pending.push(locate(location, name));
    }
  }
  return [...found].sort();
}

/** The file Node loads for a package directory (its `main`, or index.js). */
function entryFile(location: string): string {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, location, "package.json"), "utf8")) as {
    main?: string;
  };
  const main = path.posix.normalize(`${location}/${manifest.main ?? "index.js"}`);
  for (const candidate of [main, `${main}.js`, `${main}/index.js`]) {
    const file = path.join(ROOT, candidate);
    if (existsSync(file) && statSync(file).isFile()) return candidate;
  }
  throw new Error(`no entry file for ${location}`);
}

/** Built server files that pass the parser paths to the worker. */
function compiledParserFiles(): string[] {
  const files = readdirSync(SERVER_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(SERVER_DIR, file));
  return files.filter((file) => readFileSync(file, "utf8").includes("pdfParsePath"));
}

describe.skipIf(!ENABLED)("document parser in the production build", () => {
  const copies: string[] = [];
  afterAll(() => {
    vi.restoreAllMocks();
    for (const dir of copies) rmSync(dir, { recursive: true, force: true });
  });

  it("passes the parser paths to the worker as runtime lookups, not module ids", () => {
    const files = compiledParserFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      // The defect: webpack compiled require.resolve to `pdfParsePath:16297`.
      expect(code).not.toMatch(/pdfParsePath:\s*\d/);
      expect(code).not.toMatch(/mammothPath:\s*\d/);
      expect(code).toContain('process.getBuiltinModule("node:module")');
      expect(code).toContain('resolve("pdf-parse/lib/pdf-parse.js")');
      expect(code).toContain('resolve("mammoth")');
    }
  });

  it.each(PARSER_ROUTES)("traces pdf-parse, mammoth and their dependencies for %s", (route) => {
    const traced = tracedFiles(route);
    for (const file of PDF_PARSE_FILES) expect(traced, file).toContain(file);
    for (const location of parserDependencyClosure()) {
      expect(traced, `${location}/package.json`).toContain(`${location}/package.json`);
      if (location !== "node_modules/pdf-parse") {
        expect(traced, entryFile(location)).toContain(entryFile(location));
      }
    }
  });

  it("parses a PDF and a DOCX with only the traced files present", async () => {
    // A copy of what a deployment of the embed job holds under node_modules. No
    // directory above it may hold node_modules, or Node could load from there.
    const deployment = mkdtempSync(path.join(os.tmpdir(), "parser-trace-"));
    copies.push(deployment);
    for (let dir = path.dirname(deployment); ; dir = path.dirname(dir)) {
      expect(existsSync(path.join(dir, "node_modules")), dir).toBe(false);
      if (path.dirname(dir) === dir) break;
    }
    for (const file of tracedFiles("api/v1/jobs/embed-document")) {
      if (file.startsWith("node_modules/")) {
        cpSync(path.join(ROOT, file), path.join(deployment, file));
      }
    }

    vi.spyOn(process, "cwd").mockReturnValue(deployment);
    const resolved = resolveParserPaths();
    expect(resolved.pdfParsePath.startsWith(deployment)).toBe(true);
    expect(resolved.mammothPath.startsWith(deployment)).toBe(true);

    await expect(
      parseDocumentIsolated(makeTextPdf("Syveka test 123"), "application/pdf"),
    ).resolves.toContain("Syveka test 123");
    await expect(
      parseDocumentIsolated(
        makeTextDocx("Syveka DOCX test 456"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).resolves.toContain("Syveka DOCX test 456");
  });
});
