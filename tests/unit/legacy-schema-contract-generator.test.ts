import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GENERATOR_PATH = resolve(process.cwd(), "scripts/generate-legacy-schema-contract.mjs");
const SCRIPTS_DIR = resolve(process.cwd(), "scripts");
const generatorSource = readFileSync(GENERATOR_PATH, "utf8");

interface GeneratorResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Runs a (possibly mutated) copy of the generator as a real child process. The copy is written
// inside scripts/ (not an OS temp dir) so Node's ESM resolution for the bare "@prisma/client"
// specifier can walk up to this project's node_modules; it is always removed afterward.
function runGenerator(source: string): GeneratorResult {
  const scriptPath = join(
    SCRIPTS_DIR,
    `.__tmp-legacy-schema-contract-${process.pid}-${Date.now()}.mjs`,
  );
  writeFileSync(scriptPath, source, "utf8");
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

function columnRowsOf(generatorStdout: string): string[] {
  const match = generatorStdout.match(
    /-- BEGIN COMPLETE COLUMN CONTRACT\r?\n([\s\S]*?)\r?\n-- END COMPLETE COLUMN CONTRACT/,
  );
  const body = match?.[1];
  if (body === undefined) {
    throw new Error("Missing COMPLETE COLUMN CONTRACT markers in generator output.");
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

function committedColumnRows(): string[] {
  const preflight = readFileSync(
    resolve(process.cwd(), "prisma/sql/006_legacy_baseline_preflight.sql"),
    "utf8",
  );
  const startMarker = "-- Every scalar column in the schema";
  const endMarker = "-- Complete relationship contract";
  const startIndex = preflight.indexOf(startMarker);
  const endIndex = preflight.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Missing column contract markers in the committed preflight SQL.");
  }
  return preflight
    .slice(startIndex, endIndex)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\('[^']+', '[^']+',/.test(line))
    .map((line) => line.replace(/,$/, ""));
}

function legacyNullableListColumnsOf(generatorStdout: string): string[] {
  const match = generatorStdout.match(
    /-- BEGIN LEGACY NULLABLE LIST COLUMNS\r?\n([\s\S]*?)\r?\n-- END LEGACY NULLABLE LIST COLUMNS/,
  );
  const body = match?.[1];
  if (body === undefined) {
    throw new Error("Missing LEGACY NULLABLE LIST COLUMNS markers in generator output.");
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

function committedLegacyNullableListColumns(): string[] {
  const preflight = readFileSync(
    resolve(process.cwd(), "prisma/sql/006_legacy_baseline_preflight.sql"),
    "utf8",
  );
  const startMarker = "-- BEGIN LEGACY NULLABLE LIST COLUMNS";
  const endMarker = "-- END LEGACY NULLABLE LIST COLUMNS";
  const startIndex = preflight.indexOf(startMarker);
  const endIndex = preflight.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Missing LEGACY NULLABLE LIST COLUMNS markers in the committed preflight SQL.");
  }
  return preflight
    .slice(startIndex + startMarker.length, endIndex)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

describe("legacy schema contract generator", () => {
  it("exits successfully and classifies every scalar-list field with no leftover error output", () => {
    const result = runGenerator(generatorSource);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("emits not_null true for the two verified NOT NULL scalar-list columns", () => {
    const rows = columnRowsOf(runGenerator(generatorSource).stdout);
    expect(rows).toContain(
      "('booking_types', 'duration_options', 'integer[]', 'true', '', '', 'array[30]')",
    );
    expect(rows).toContain(
      "('calendar_connections', 'scopes', 'text[]', 'true', '', '', 'array[]')",
    );
  });

  it("emits not_null false for the two verified nullable scalar-list columns", () => {
    const rows = columnRowsOf(runGenerator(generatorSource).stdout);
    expect(rows).toContain("('api_keys', 'scopes', 'text[]', 'false', '', '', 'array[]')");
    expect(rows).toContain("('webhook_endpoints', 'events', 'text[]', 'false', '', '', '')");
  });

  it("generates column rows that match the committed compatibility contract exactly", () => {
    const generated = columnRowsOf(runGenerator(generatorSource).stdout);
    expect(generated).toEqual(committedColumnRows());
  });

  it("generates exactly the two verified legacy-nullable list columns", () => {
    const rows = legacyNullableListColumnsOf(runGenerator(generatorSource).stdout);
    expect(rows).toEqual(["'booking_types.duration_options'", "'calendar_connections.scopes'"]);
  });

  it("generates a legacy-nullable list that matches the committed preflight SQL exactly", () => {
    const generated = legacyNullableListColumnsOf(runGenerator(generatorSource).stdout);
    expect(generated).toEqual(committedLegacyNullableListColumns());
  });

  it("fails closed when a legacy-nullable entry has no LIST_COLUMN_NOT_NULL entry", () => {
    const mutated = generatorSource.replace(
      /const LEGACY_NULLABLE_LIST_COLUMNS = \[[^\]]*\];/,
      'const LEGACY_NULLABLE_LIST_COLUMNS = ["booking_types.duration_options", "not_a_real_table.not_a_real_column"];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no LIST_COLUMN_NOT_NULL entry");
    expect(result.stderr).toContain("not_a_real_table.not_a_real_column");
  });

  it("fails closed when a legacy-nullable entry's target nullability is not NOT NULL", () => {
    const mutated = generatorSource.replace(
      /const LEGACY_NULLABLE_LIST_COLUMNS = \[[^\]]*\];/,
      'const LEGACY_NULLABLE_LIST_COLUMNS = ["booking_types.duration_options", "api_keys.scopes"];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("whose target nullability is not NOT NULL");
    expect(result.stderr).toContain("api_keys.scopes");
  });

  it("fails closed with a clear error when a scalar-list column has no explicit entry", () => {
    const mutated = generatorSource.replace(
      /  \["booking_types\.duration_options", true\],\r?\n/,
      "",
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LIST_COLUMN_NOT_NULL is missing an entry");
    expect(result.stderr).toContain("booking_types.duration_options");
  });

  it("fails closed with a clear error when the map contains a stale entry", () => {
    const mutated = generatorSource.replace(
      /(  \["calendar_connections\.scopes", true\],\r?\n)/,
      '$1  ["not_a_real_table.not_a_real_column", true],\n',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stale entry");
    expect(result.stderr).toContain("not_a_real_table.not_a_real_column");
  });

  it("fails closed with a clear error on a duplicate map entry", () => {
    const mutated = generatorSource.replace(
      /(  \["api_keys\.scopes", false\],\r?\n)/,
      '$1  ["api_keys.scopes", false],\n',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Duplicate LIST_COLUMN_NOT_NULL entry");
    expect(result.stderr).toContain("api_keys.scopes");
  });
});
