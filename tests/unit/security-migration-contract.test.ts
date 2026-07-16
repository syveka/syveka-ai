import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260715230000_security_invariant_corrections/migration.sql",
  ),
  "utf8",
);

describe("security invariant corrective migration", () => {
  it.each([
    'UNIQUE INDEX IF NOT EXISTS "collections_organization_id_id_key"',
    'UNIQUE INDEX IF NOT EXISTS "documents_organization_id_id_key"',
    'UNIQUE INDEX IF NOT EXISTS "conversations_organization_id_id_key"',
    'FOREIGN KEY ("organization_id", "collection_id")',
    'FOREIGN KEY ("organization_id", "conversation_id")',
    'FOREIGN KEY ("organization_id", "document_id")',
    'CHECK ("storage_path" LIKE "organization_id"::text || \'/%\')',
    'VALIDATE CONSTRAINT "document_upload_intents_tenant_path_check"',
  ])("contains %s", (statement) => {
    expect(migration).toContain(statement);
  });
});
