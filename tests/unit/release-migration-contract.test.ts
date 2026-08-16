import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n?/g, "\n");

const baseline = read("prisma/migrations/20260701000000_initial_baseline/migration.sql");
const preflight = read("prisma/sql/006_legacy_baseline_preflight.sql");
const security = read("prisma/migrations/20260719000000_initial_security_baseline/migration.sql");
const releaseInvariants = read("tests/staging/release-invariants.sql");
const storage = read("prisma/sql/004_storage.sql");
const stagingWorkflow = read(".github/workflows/staging-release.yml");
const productionWorkflow = read(".github/workflows/deploy.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const legacyProvision = read("scripts/ci/provision-legacy-database.sh");

function betweenMarkers(source: string, startMarker: string, endMarker: string, label: string) {
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) {
    throw new Error(`Missing ${label} start marker: ${startMarker}`);
  }

  const contentStart = startIndex + startMarker.length;
  const endIndex = source.indexOf(endMarker, contentStart);
  if (endIndex < 0) {
    throw new Error(`Missing ${label} end marker: ${endMarker}`);
  }

  return source.slice(contentStart, endIndex).replace(/\r\n/g, "\n").trim();
}

function compatibilityContract(sql: string) {
  return betweenMarkers(
    sql,
    "-- BEGIN LEGACY BASELINE COMPATIBILITY CONTRACT",
    "-- END LEGACY BASELINE COMPATIBILITY CONTRACT",
    "legacy compatibility contract",
  );
}

function rlsPolicyContract(sql: string) {
  return betweenMarkers(
    sql,
    "-- BEGIN COMPLETE RLS POLICY CONTRACT",
    "-- END COMPLETE RLS POLICY CONTRACT",
    "complete RLS policy contract",
  );
}

function policyRows(contract: string): string[] {
  return contract.match(/^      \('public',.*$/gm) ?? [];
}

describe("staging release migration contract", () => {
  it("uses the identical read-only preflight contract inside the atomic baseline", () => {
    const contract = compatibilityContract(preflight);
    expect(contract).toBe(compatibilityContract(baseline));
    expect(contract).toContain(
      "-- BEGIN LEGACY MISSING TABLES\n  legacy_missing_tables TEXT[] := ARRAY[\n" +
        "    'business_dna',\n" +
        "    'inbox_threads',\n" +
        "    'inbox_messages',\n" +
        "    'inbox_mailboxes',\n" +
        "    'stripe_webhook_events',\n" +
        "    'compliance_controls',\n" +
        "    'control_framework_mappings',\n" +
        "    'compliance_evidence',\n" +
        "    'compliance_risks',\n" +
        "    'security_policies',\n" +
        "    'policy_acknowledgements',\n" +
        "    'security_incidents',\n" +
        "    'incident_events',\n" +
        "    'subprocessors',\n" +
        "    'processing_records',\n" +
        "    'data_subject_requests',\n" +
        "    'dsr_events',\n" +
        "    'retention_policies',\n" +
        "    'retention_executions',\n" +
        "    'privacy_security_assessments',\n" +
        "    'access_reviews',\n" +
        "    'certifications',\n" +
        "    'compliance_audit_log'\n" +
        "  ];\n-- END LEGACY MISSING TABLES",
    );
    expect(contract).not.toContain("ARRAY[]");
    // The baseline must not wrap itself in an explicit BEGIN/COMMIT: Prisma
    // already applies each migration.sql inside its own transaction, and the
    // extra literal BEGIN/COMMIT caused Prisma's schema engine to report a
    // generic "current transaction is aborted" error instead of the real
    // PostgreSQL error whenever an earlier statement failed.
    expect(baseline.trimStart()).not.toMatch(/^BEGIN;/);
    expect(baseline.trimEnd()).not.toMatch(/COMMIT;$/);
    // Every object this migration creates must tolerate re-application from a
    // partially-created database (e.g. one originally provisioned with
    // `prisma db push`, or left behind by an earlier interrupted deploy).
    expect(baseline).toContain('CREATE TABLE IF NOT EXISTS "users"');
    expect(baseline).toMatch(/CREATE TYPE "Locale" AS ENUM/);
    expect(baseline).toMatch(
      /SELECT 1 FROM pg_type WHERE typname = 'Locale' AND typnamespace = 'public'::regnamespace/,
    );
    expect(baseline).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key"');
    expect(baseline).toMatch(
      /SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_organization_id_fkey'/,
    );
    expect(preflight).toContain("pg_attribute");
    expect(preflight).toContain("pg_constraint");
    expect(preflight).toContain("pg_index");
    expect(preflight).toContain("pg_enum");
    expect(preflight).toContain("refused a partially provisioned schema");
    expect(preflight).toContain("Every scalar column in the schema");
    expect(preflight).toContain("'vector(1536)'");
    expect(preflight).toContain("format_type(attribute.atttypid, attribute.atttypmod)");
    expect(preflight).toContain("constraint_row.confrelid");
    expect(preflight).toContain("constraint_row.convalidated");
    expect(preflight).toContain("constraint_row.condeferrable");
    const columnRows = betweenMarkers(
      contract,
      "-- Every scalar column in the schema",
      "-- Complete relationship contract",
      "complete column contract",
    ).match(/^      \('[^']+', '[^']+',/gm);
    const foreignKeyRows = betweenMarkers(
      contract,
      "-- Complete relationship contract",
      "  FOR expected IN\n    SELECT * FROM (VALUES\n      ('Locale'",
      "complete foreign-key contract",
    ).match(/^      \('public', '[^']+', '[^']+_fkey',/gm);
    expect(columnRows).toHaveLength(742);
    expect(foreignKeyRows).toHaveLength(85);
    expect(contract).toContain("expected.table_name = ANY(legacy_missing_tables)");
    expect(contract).toContain("expected.source_table = ANY(legacy_missing_tables)");
    expect(contract).toContain("expected.target_table = ANY(legacy_missing_tables)");
    // Scalar-list (array) columns cannot express nullability via Prisma's DMMF (Prisma has no
    // optional-list syntax), so each column's real PostgreSQL NOT NULL status is verified
    // against migration history and pinned here explicitly to guard against regressions like
    // the one fixed by this test: a blanket "isList => not_null false" heuristic silently
    // mis-marked NOT NULL array columns as nullable.
    expect(contract).toContain("('api_keys', 'scopes', 'text[]', 'false', '', '', 'array[]')");
    expect(contract).toContain("('webhook_endpoints', 'events', 'text[]', 'false', '', '', '')");
    expect(contract).toContain(
      "('booking_types', 'duration_options', 'integer[]', 'true', '', '', 'array[30]')",
    );
    expect(contract).toContain(
      "('calendar_connections', 'scopes', 'text[]', 'true', '', '', 'array[]')",
    );
    // Real legacy databases (provisioned via `prisma db push` against the pre-migration-system
    // schema) have these two NOT-NULL-target columns as nullable, because Prisma's db push does
    // not emit NOT NULL for scalar-list columns. The pre-upgrade preflight must tolerate exactly
    // this pair without weakening the check for any other column; NOT NULL is enforced for real
    // by the 20260726000000_normalize_list_column_nullability migration below.
    expect(contract).toContain("legacy_nullable_list_columns");
    expect(contract).toContain("'booking_types.duration_options'");
    expect(contract).toContain("'calendar_connections.scopes'");
    expect(releaseInvariants).toContain("20260726000000_normalize_list_column_nullability");
    expect(releaseInvariants).toContain(
      "booking_types.duration_options and calendar_connections.scopes must be NOT NULL after migration",
    );
    expect(contract).toContain(
      "('conversations', 'title', 'text', 'true', '', '', '''new conversation''')",
    );
    expect(contract).toContain(`'::("[^"]+"|[a-z_][a-z0-9_]*)(\\[\\])?'`);
    expect(contract).toContain("'[()]'");
  });

  it("fails closed on same-name tenant and storage policy drift", () => {
    expect(security.trimStart()).toMatch(/^BEGIN;/);
    expect(security.trimEnd()).toMatch(/COMMIT;$/);
    expect(security).toContain("assert_syveka_policy_contract");
    expect(security).toContain("universally true predicate");
    expect(security).not.toMatch(/DROP\s+POLICY/i);
    const rlsContract = rlsPolicyContract(security);
    // security-baseline's contract runs mid-deploy, so it can only ever
    // assert policies that already exist at that point in migration history
    // — it must be a subset of (not identical to) release-invariants.sql's
    // contract, which runs at the very end and reflects every migration,
    // including ones (like business_dna) whose CREATE POLICY statements run
    // after this file. See the comment above this file's own RLS DO block.
    const securityRows = policyRows(rlsContract);
    const releaseInvariantRows = new Set(policyRows(rlsPolicyContract(releaseInvariants)));
    expect(securityRows.length).toBeGreaterThan(0);
    for (const row of securityRows) {
      expect(releaseInvariantRows.has(row)).toBe(true);
    }
    expect(securityRows).toHaveLength(86);
    expect(releaseInvariantRows.size).toBe(90);
    // The only rows release-invariants carries beyond security-baseline are
    // business_dna's — anything else diverging would be real, unexplained drift.
    const extraRows = [...releaseInvariantRows].filter((row) => !securityRows.includes(row));
    expect(extraRows.sort()).toEqual(
      [
        "      ('public', 'business_dna', 'business_dna_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),",
        "      ('public', 'business_dna', 'business_dna_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),",
        "      ('public', 'business_dna', 'business_dna_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),",
        "      ('public', 'business_dna', 'business_dna_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),",
      ].sort(),
    );
    expect(rlsPolicyContract(security)).toContain("messages_select");
    expect(rlsPolicyContract(security)).toContain("prompts_select");
    expect(rlsPolicyContract(security)).toContain("availability_rules_select");
    expect(rlsPolicyContract(security)).toContain("conversation_documents_tenant_isolation");
    expect(rlsPolicyContract(security)).toContain("policy.permissive");
    expect(rlsPolicyContract(security)).toContain("policy.roles::TEXT[]");
    expect(storage.trimStart()).toContain("begin;");
    expect(storage.trimEnd()).toMatch(/commit;$/i);
    expect(storage).toContain("unexpected predicate");
    expect(storage).not.toMatch(/drop\s+policy/i);
  });

  it("keeps staging manual, main-only, and secret-scoped", () => {
    expect(stagingWorkflow).toContain("workflow_dispatch:");
    expect(stagingWorkflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(stagingWorkflow).toContain("environment: staging");
    expect(stagingWorkflow).not.toContain("environment: production");
    const jobPreamble = stagingWorkflow.split("    steps:", 1)[0];
    expect(jobPreamble).not.toContain("STAGING_DIRECT_URL:");
    expect(jobPreamble).not.toContain("STAGING_SUPABASE_SERVICE_ROLE_KEY:");
    expect(stagingWorkflow).not.toMatch(/run:[^\n]*\$\{\{\s*inputs\./);
    expect(stagingWorkflow).toContain('VERCEL_CLI_VERSION: "56.3.2"');
  });

  it("requires a manual immutable production release chain", () => {
    expect(productionWorkflow).toContain("workflow_dispatch:");
    expect(productionWorkflow).not.toContain("workflow_run:");
    expect(productionWorkflow).not.toMatch(/\n\s+push:/);
    expect(productionWorkflow).toContain("candidate_sha:");
    expect(productionWorkflow).toContain("confirm_production_sha:");
    expect(productionWorkflow).toContain("environment: production");
    expect(productionWorkflow).toContain("Verify main, CI, staging, and manual confirmation");
    expect(productionWorkflow).toContain(
      "ref: ${{ needs.verify-release-chain.outputs.candidate_sha }}",
    );
    expect(productionWorkflow).toContain('VERCEL_CLI_VERSION: "56.3.2"');
  });

  it("scans a validated commit range without an API-dependent wrapper", () => {
    expect(ciWorkflow).toContain('GITLEAKS_VERSION: "8.24.3"');
    expect(ciWorkflow).toContain('--log-opts="$BASE_SHA..$HEAD_SHA"');
    expect(ciWorkflow).toContain("--redact");
    expect(ciWorkflow).not.toContain("gitleaks/gitleaks-action@v2");
  });

  it("tests empty, legacy, structural, FK, and special-policy drift in CI", () => {
    expect(ciWorkflow).toContain("Deploy complete migration history to empty PostgreSQL");
    expect(legacyProvision).toContain("6f6ab84f0f3849a172e0fdfdc49610058640d56c");
    expect(ciWorkflow).toContain("partial_schema");
    expect(ciWorkflow).toContain("drifted_schema");
    expect(ciWorkflow).toContain("weak_policy");
    expect(ciWorkflow).toContain("missing_column");
    expect(ciWorkflow).toContain("column_drift");
    expect(ciWorkflow).toContain("fk_wrong_source");
    expect(ciWorkflow).toContain("fk_wrong_target");
    expect(ciWorkflow).toContain("fk_not_valid");
    expect(ciWorkflow).toContain("weak_messages");
    expect(ciWorkflow).toContain("weak_prompts");
    expect(ciWorkflow).toContain("weak_calendar");
    expect(ciWorkflow).toContain("wrong_policy_role");
    expect(ciWorkflow).toContain("wrong_policy_command");
    expect(ciWorkflow).toContain("storage_policy");
    expect(ciWorkflow).toContain("migration-upgrade");
  });
});
