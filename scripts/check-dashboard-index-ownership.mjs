import { readFileSync } from "node:fs";

const migrationPath = "prisma/migrations/20260712000000_dashboard_indexes/migration.sql";
const setupPath = "prisma/sql/001_extensions_and_indexes.sql";

const expectedIndexes = [
  "deals_organization_id_closed_at_idx",
  "deals_organization_id_pipeline_id_closed_at_idx",
  "activities_organization_id_type_due_at_idx",
  "activities_organization_id_type_created_at_idx",
  "conversations_organization_id_updated_at_idx",
];

const migrationSql = readFileSync(migrationPath, "utf8");
const setupSql = readFileSync(setupPath, "utf8");

let failed = false;

for (const indexName of expectedIndexes) {
  if (!migrationSql.includes(indexName)) {
    console.error(`Missing dashboard index from migration: ${indexName}`);
    failed = true;
  }

  if (setupSql.includes(indexName)) {
    console.error(`Dashboard index is duplicated in setup SQL: ${indexName}`);
    failed = true;
  }
}

if (!failed) {
  console.log(
    `Dashboard index ownership verified: ${expectedIndexes.length} migration-owned indexes`,
  );
}

process.exit(failed ? 1 : 0);
