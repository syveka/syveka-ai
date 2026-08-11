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

function legacyMissingColumnsOf(generatorStdout: string): string[] {
  const match = generatorStdout.match(
    /-- BEGIN LEGACY MISSING COLUMNS\r?\n([\s\S]*?)\r?\n-- END LEGACY MISSING COLUMNS/,
  );
  const body = match?.[1];
  if (body === undefined) {
    throw new Error("Missing LEGACY MISSING COLUMNS markers in generator output.");
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

function committedLegacyMissingColumns(): string[] {
  const preflight = readFileSync(
    resolve(process.cwd(), "prisma/sql/006_legacy_baseline_preflight.sql"),
    "utf8",
  );
  const startMarker = "-- BEGIN LEGACY MISSING COLUMNS";
  const endMarker = "-- END LEGACY MISSING COLUMNS";
  const startIndex = preflight.indexOf(startMarker);
  const endIndex = preflight.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Missing LEGACY MISSING COLUMNS markers in the committed preflight SQL.");
  }
  return preflight
    .slice(startIndex + startMarker.length, endIndex)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

function legacyMissingTablesDeclarationOf(generatorStdout: string): string {
  const match = generatorStdout.match(
    /-- BEGIN LEGACY MISSING TABLES\r?\n([\s\S]*?)\r?\n-- END LEGACY MISSING TABLES/,
  );
  const body = match?.[1];
  if (body === undefined) {
    throw new Error("Missing LEGACY MISSING TABLES markers in generator output.");
  }
  return body.replace(/\r\n/g, "\n").trim();
}

function committedLegacyMissingTablesDeclaration(): string {
  const preflight = readFileSync(
    resolve(process.cwd(), "prisma/sql/006_legacy_baseline_preflight.sql"),
    "utf8",
  );
  return legacyMissingTablesDeclarationOf(preflight);
}

function legacyForeignKeyOverridesOf(generatorStdout: string): string[] {
  const match = generatorStdout.match(
    /-- BEGIN LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES\r?\n([\s\S]*?)\r?\n-- END LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES/,
  );
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(
      "Missing LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES markers in generator output.",
    );
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

function committedLegacyForeignKeyOverrides(): string[] {
  const preflight = readFileSync(
    resolve(process.cwd(), "prisma/sql/006_legacy_baseline_preflight.sql"),
    "utf8",
  );
  const startMarker = "-- BEGIN LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES";
  const endMarker = "-- END LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES";
  const startIndex = preflight.indexOf(startMarker);
  const endIndex = preflight.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(
      "Missing LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES markers in the committed preflight SQL.",
    );
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

  it("emits exactly the one approved legacy-missing column", () => {
    const rows = legacyMissingColumnsOf(runGenerator(generatorSource).stdout);
    expect(rows).toEqual(["'calendar_sync_states.webhook_verification_secret_hash'"]);
  });

  it("generates a legacy-missing-columns block that matches the committed preflight SQL exactly", () => {
    const generated = legacyMissingColumnsOf(runGenerator(generatorSource).stdout);
    expect(generated).toEqual(committedLegacyMissingColumns());
  });

  it("the complete target column contract still contains the legacy-missing column", () => {
    const rows = columnRowsOf(runGenerator(generatorSource).stdout);
    expect(rows).toContain(
      "('calendar_sync_states', 'webhook_verification_secret_hash', 'text', 'false', '', '', '')",
    );
  });

  it("fails closed on a duplicate LEGACY_MISSING_COLUMN_ENTRIES key", () => {
    const mutated = generatorSource.replace(
      /(\[\s*\r?\n\s*"calendar_sync_states\.webhook_verification_secret_hash",\s*\r?\n\s*"20260728000000_calendar_webhook_verification_secret",\s*\r?\n\s*\],)/,
      "$1$1",
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Duplicate LEGACY_MISSING_COLUMN entry");
  });

  it("fails closed when a LEGACY_MISSING_COLUMN entry names a nonexistent/stale schema column", () => {
    const mutated = generatorSource.replace(
      /"calendar_sync_states\.webhook_verification_secret_hash"/,
      '"not_a_real_table.not_a_real_column"',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not a real scalar column");
    expect(result.stderr).toContain("not_a_real_table.not_a_real_column");
  });

  it("fails closed when a LEGACY_MISSING_COLUMN entry names a nonexistent migration directory", () => {
    const mutated = generatorSource.replace(
      '"20260728000000_calendar_webhook_verification_secret"',
      '"20269999999999_not_a_real_migration"',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("which does not exist at");
    expect(result.stderr).toContain("20269999999999_not_a_real_migration");
  });

  it("fails closed when the named migration does not add the exact column", () => {
    const mutated = generatorSource.replace(
      '"20260728000000_calendar_webhook_verification_secret"',
      '"20260726000000_normalize_list_column_nullability"',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not add column");
    expect(result.stderr).toContain("webhook_verification_secret_hash");
  });

  const DEFAULT_LEGACY_MISSING_TABLE_ENTRIES =
    'const LEGACY_MISSING_TABLE_ENTRIES = [["business_dna", "20260811000000_business_dna_v1"]];';

  it("fails closed when a legacy-missing table references a nonexistent migration directory", () => {
    const mutated = generatorSource.replace(
      DEFAULT_LEGACY_MISSING_TABLE_ENTRIES,
      'const LEGACY_MISSING_TABLE_ENTRIES = [["users", "20269999999999_not_a_real_migration"]];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LEGACY_MISSING_TABLE_ENTRIES references migration");
    expect(result.stderr).toContain("20269999999999_not_a_real_migration");
  });

  it("fails closed when the named migration does not create the legacy-missing table", () => {
    const mutated = generatorSource.replace(
      DEFAULT_LEGACY_MISSING_TABLE_ENTRIES,
      'const LEGACY_MISSING_TABLE_ENTRIES = [["users", "20260726000000_normalize_list_column_nullability"]];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not create table "users"');
  });

  it("fails closed when a legacy-missing table is absent from the Prisma schema", () => {
    const mutated = generatorSource.replace(
      DEFAULT_LEGACY_MISSING_TABLE_ENTRIES,
      'const LEGACY_MISSING_TABLE_ENTRIES = [["not_a_real_table", "20260701000000_initial_baseline"]];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('references "not_a_real_table"');
    expect(result.stderr).toContain("is not a real table in the current Prisma schema");
  });

  it("fails closed on duplicate legacy-missing-table entries", () => {
    const mutated = generatorSource.replace(
      DEFAULT_LEGACY_MISSING_TABLE_ENTRIES,
      'const LEGACY_MISSING_TABLE_ENTRIES = [["users", "20260701000000_initial_baseline"], ["users", "20260701000000_initial_baseline"]];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Duplicate LEGACY_MISSING_TABLE entry for table "users"');
  });

  it("emits valid PostgreSQL for an empty legacy-missing-table list", () => {
    const mutated = generatorSource.replace(
      DEFAULT_LEGACY_MISSING_TABLE_ENTRIES,
      "const LEGACY_MISSING_TABLE_ENTRIES = [];",
    );
    expect(mutated).not.toBe(generatorSource);

    const stdout = runGenerator(mutated).stdout;
    expect(legacyMissingTablesDeclarationOf(stdout)).toBe(
      "legacy_missing_tables TEXT[] := '{}'::TEXT[];",
    );
    expect(stdout).not.toContain("ARRAY[]");
  });

  it("emits a valid PostgreSQL array for the real (business_dna) legacy-missing-table list, matching the committed contract", () => {
    const stdout = runGenerator(generatorSource).stdout;
    expect(legacyMissingTablesDeclarationOf(stdout)).toBe(
      "legacy_missing_tables TEXT[] := ARRAY[\n    'business_dna'\n  ];",
    );
    expect(legacyMissingTablesDeclarationOf(stdout)).toBe(
      committedLegacyMissingTablesDeclaration(),
    );
  });

  it("emits a valid PostgreSQL array for a validated multi-entry legacy-missing-table list", () => {
    const mutated = generatorSource.replace(
      DEFAULT_LEGACY_MISSING_TABLE_ENTRIES,
      'const LEGACY_MISSING_TABLE_ENTRIES = [["business_dna", "20260811000000_business_dna_v1"], ["users", "20260701000000_initial_baseline"]];',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).toBe(0);
    expect(legacyMissingTablesDeclarationOf(result.stdout)).toBe(
      "legacy_missing_tables TEXT[] := ARRAY[\n    'business_dna',\n    'users'\n  ];",
    );
  });

  it("places legacy-missing-table markers between missing columns and foreign keys", () => {
    const stdout = runGenerator(generatorSource).stdout;
    const missingColumnsEnd = stdout.indexOf("-- END LEGACY MISSING COLUMNS");
    const missingTablesStart = stdout.indexOf("-- BEGIN LEGACY MISSING TABLES");
    const missingTablesEnd = stdout.indexOf("-- END LEGACY MISSING TABLES");
    const foreignKeysStart = stdout.indexOf("-- BEGIN COMPLETE FOREIGN KEY CONTRACT");
    expect(missingColumnsEnd).toBeGreaterThan(-1);
    expect(missingTablesStart).toBeGreaterThan(missingColumnsEnd);
    expect(missingTablesEnd).toBeGreaterThan(missingTablesStart);
    expect(foreignKeysStart).toBeGreaterThan(missingTablesEnd);
  });

  it("emits exactly the one approved legacy foreign-key update-action override", () => {
    const rows = legacyForeignKeyOverridesOf(runGenerator(generatorSource).stdout);
    expect(rows).toEqual([
      "'conversation_documents_organization_id_fkey=NoAction=" +
        "20260729000000_conversation_documents_organization_fk_on_update'",
    ]);
  });

  it("generates a legacy foreign-key override block that matches the committed preflight SQL exactly", () => {
    const generated = legacyForeignKeyOverridesOf(runGenerator(generatorSource).stdout);
    expect(generated).toEqual(committedLegacyForeignKeyOverrides());
  });

  it("still requires the final ON DELETE CASCADE / ON UPDATE CASCADE definition in the complete foreign-key contract", () => {
    const result = runGenerator(generatorSource);
    expect(result.stdout).toContain(
      "('public', 'conversation_documents', 'conversation_documents_organization_id_fkey', " +
        "'{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', " +
        "'false', 'false', 'true')",
    );
  });

  it("fails closed on a duplicate LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES constraint", () => {
    const mutated = generatorSource.replace(
      /(\[\s*\r?\n\s*"conversation_documents_organization_id_fkey",\s*\r?\n\s*"NoAction",\s*\r?\n\s*"20260729000000_conversation_documents_organization_fk_on_update",\s*\r?\n\s*\],)/,
      "$1$1",
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Duplicate LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES entry");
  });

  it("fails closed when an override entry's legacy update action contains a literal '='", () => {
    const mutated = generatorSource.replace('"NoAction"', '"No=Action"');
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('contains a literal "="');
  });

  it("fails closed when a foreign-key override references a nonexistent constraint", () => {
    const mutated = generatorSource.replace(
      '"conversation_documents_organization_id_fkey"',
      '"not_a_real_table_not_a_real_fkey"',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("which is not a real foreign key");
    expect(result.stderr).toContain("not_a_real_table_not_a_real_fkey");
  });

  it("fails closed when a foreign-key override's legacy value matches the final target value", () => {
    const mutated = generatorSource.replace('"NoAction"', '"Cascade"');
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("matches its final target update action");
  });

  it("fails closed when a foreign-key override references a nonexistent migration directory", () => {
    const mutated = generatorSource.replace(
      '"20260729000000_conversation_documents_organization_fk_on_update"',
      '"20269999999999_not_a_real_migration"',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("which does not exist at");
    expect(result.stderr).toContain("20269999999999_not_a_real_migration");
  });

  it("fails closed when the named migration does not drop and re-add the constraint with the final action", () => {
    const mutated = generatorSource.replace(
      '"20260729000000_conversation_documents_organization_fk_on_update"',
      '"20260728000000_calendar_webhook_verification_secret"',
    );
    expect(mutated).not.toBe(generatorSource);

    const result = runGenerator(mutated);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not drop and re-add constraint");
    expect(result.stderr).toContain("conversation_documents_organization_id_fkey");
  });

  it("places the legacy foreign-key override markers after the complete foreign-key contract and before the RLS policy contract", () => {
    const stdout = runGenerator(generatorSource).stdout;
    const fkEnd = stdout.indexOf("-- END COMPLETE FOREIGN KEY CONTRACT");
    const overrideStart = stdout.indexOf("-- BEGIN LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES");
    const overrideEnd = stdout.indexOf("-- END LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES");
    const rlsStart = stdout.indexOf("-- BEGIN COMPLETE RLS POLICY CONTRACT");
    expect(fkEnd).toBeGreaterThan(-1);
    expect(overrideStart).toBeGreaterThan(fkEnd);
    expect(overrideEnd).toBeGreaterThan(overrideStart);
    expect(rlsStart).toBeGreaterThan(overrideEnd);
  });
});
