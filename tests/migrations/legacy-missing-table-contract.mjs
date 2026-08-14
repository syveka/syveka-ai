import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pgUrl = process.env.PGURL;
if (!pgUrl) {
  throw new Error("PGURL is required for the ephemeral PostgreSQL contract test.");
}

const fixtureTable = "legacy_missing_table_fixture";
const fixtureConstraint = `${fixtureTable}_organization_id_fkey`;
const tempDirectory = mkdtempSync(join(tmpdir(), "syveka-legacy-missing-table-"));
const fixturePath = join(tempDirectory, "preflight.sql");

function replaceOnce(source, search, replacement, label) {
  if (source.split(search).length !== 2) {
    throw new Error(`Expected exactly one ${label} anchor in the preflight SQL.`);
  }
  return source.replace(search, replacement);
}

function insertContractRows(source, sectionMarker, rows) {
  const sectionIndex = source.indexOf(sectionMarker);
  if (sectionIndex < 0) {
    throw new Error(`Missing preflight section marker: ${sectionMarker}`);
  }
  const valuesAnchor = "    SELECT * FROM (VALUES\n";
  const valuesIndex = source.indexOf(valuesAnchor, sectionIndex);
  if (valuesIndex < 0) {
    throw new Error(`Missing VALUES contract after marker: ${sectionMarker}`);
  }
  const insertionIndex = valuesIndex + valuesAnchor.length;
  return source.slice(0, insertionIndex) + rows + source.slice(insertionIndex);
}

function databaseUrl(database) {
  const url = new URL(pgUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function runPsql(database, args, { expectSuccess = true } = {}) {
  const result = spawnSync(
    "psql",
    [databaseUrl(database), "-X", "-v", "ON_ERROR_STOP=1", ...args],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(`Unable to start psql: ${result.error.message}`);
  }
  if (expectSuccess && result.status !== 0) {
    throw new Error(`psql failed unexpectedly:\n${result.stdout}${result.stderr}`);
  }
  if (!expectSuccess && result.status === 0) {
    throw new Error("The malformed existing-table preflight unexpectedly succeeded.");
  }
  return `${result.stdout}${result.stderr}`;
}

try {
  let fixture = readFileSync(
    resolve("prisma/sql/006_legacy_baseline_preflight.sql"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  fixture = replaceOnce(
    fixture,
    "  legacy_missing_tables TEXT[] := ARRAY[\n" +
      "    'business_dna',\n" +
      "    'inbox_threads',\n" +
      "    'inbox_messages',\n" +
      "    'inbox_mailboxes',\n" +
      "    'stripe_webhook_events'\n" +
      "  ];",
    "  legacy_missing_tables TEXT[] := ARRAY[\n" +
      "    'business_dna',\n" +
      "    'inbox_threads',\n" +
      "    'inbox_messages',\n" +
      "    'inbox_mailboxes',\n" +
      "    'stripe_webhook_events',\n" +
      `    '${fixtureTable}'\n` +
      "  ];",
    "legacy-missing-table declaration",
  );
  fixture = insertContractRows(
    fixture,
    "-- Every scalar column in the schema",
    `      ('${fixtureTable}', 'id', 'uuid', 'true', '', '', ''),\n` +
      `      ('${fixtureTable}', 'organization_id', 'uuid', 'true', '', '', ''),\n`,
  );
  fixture = insertContractRows(
    fixture,
    "-- Complete relationship contract",
    `      ('public', '${fixtureTable}', '${fixtureConstraint}', '{organization_id}', ` +
      "'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),\n",
  );
  writeFileSync(fixturePath, fixture, "utf8");

  const absentBefore = runPsql("missing_table_allowlist_absent", [
    "-Atqc",
    `SELECT to_regclass('public.${fixtureTable}') IS NULL`,
  ]).trim();
  if (absentBefore !== "t") {
    throw new Error("The allowlist-absent fixture table unexpectedly exists before preflight.");
  }
  runPsql("missing_table_allowlist_absent", ["-f", fixturePath]);
  const absentAfter = runPsql("missing_table_allowlist_absent", [
    "-Atqc",
    `SELECT to_regclass('public.${fixtureTable}') IS NULL`,
  ]).trim();
  if (absentAfter !== "t") {
    throw new Error("The preflight created or repaired the allowlist-absent fixture table.");
  }

  runPsql("missing_table_allowlist_bad_column", [
    "-c",
    `CREATE TABLE public.${fixtureTable} (id text NOT NULL, organization_id uuid NOT NULL)`,
  ]);
  const columnFailure = runPsql("missing_table_allowlist_bad_column", ["-f", fixturePath], {
    expectSuccess: false,
  });
  if (!columnFailure.includes(`incompatible column ${fixtureTable}.id`)) {
    throw new Error(`The malformed column failed for an unexpected reason:\n${columnFailure}`);
  }
  const columnTypeAfter = runPsql("missing_table_allowlist_bad_column", [
    "-Atqc",
    `SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = ` +
      `'public.${fixtureTable}'::regclass AND attname = 'id'`,
  ]).trim();
  if (columnTypeAfter !== "text") {
    throw new Error(`The preflight mutated the malformed column to ${columnTypeAfter}.`);
  }

  runPsql("missing_table_allowlist_bad_fk", [
    "-c",
    `CREATE TABLE public.${fixtureTable} (` +
      "id uuid NOT NULL PRIMARY KEY, organization_id uuid NOT NULL, " +
      `CONSTRAINT ${fixtureConstraint} FOREIGN KEY (organization_id) ` +
      "REFERENCES public.organizations(id) ON DELETE RESTRICT ON UPDATE CASCADE)",
  ]);
  const foreignKeyFailure = runPsql("missing_table_allowlist_bad_fk", ["-f", fixturePath], {
    expectSuccess: false,
  });
  if (!foreignKeyFailure.includes(`incompatible foreign key ${fixtureConstraint}`)) {
    throw new Error(
      `The malformed foreign key failed for an unexpected reason:\n${foreignKeyFailure}`,
    );
  }
  const deleteActionAfter = runPsql("missing_table_allowlist_bad_fk", [
    "-Atqc",
    `SELECT confdeltype FROM pg_constraint WHERE conname = '${fixtureConstraint}'`,
  ]).trim();
  if (deleteActionAfter !== "r") {
    throw new Error(`The preflight mutated the malformed foreign key to ${deleteActionAfter}.`);
  }

  console.log(
    "Legacy missing-table allowlist is absence-only and fails closed without repairs once the table exists.",
  );
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
