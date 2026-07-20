import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const baseline = read("prisma/migrations/20260701000000_initial_baseline/migration.sql");
const preflight = read("prisma/sql/006_legacy_baseline_preflight.sql");
const security = read("prisma/migrations/20260719000000_initial_security_baseline/migration.sql");
const releaseInvariants = read("tests/staging/release-invariants.sql");
const storage = read("prisma/sql/004_storage.sql");
const stagingWorkflow = read(".github/workflows/staging-release.yml");
const productionWorkflow = read(".github/workflows/deploy.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const legacyProvision = read("scripts/ci/provision-legacy-database.sh");

function compatibilityContract(sql: string) {
  const match = sql.match(
    /-- BEGIN LEGACY BASELINE COMPATIBILITY CONTRACT([\s\S]*?)-- END LEGACY BASELINE COMPATIBILITY CONTRACT/,
  );
  if (!match?.[1]) throw new Error("Missing legacy compatibility contract markers.");
  return match[1].replace(/\r\n/g, "\n").trim();
}

function rlsPolicyContract(sql: string) {
  const match = sql.match(
    /-- BEGIN COMPLETE RLS POLICY CONTRACT([\s\S]*?)-- END COMPLETE RLS POLICY CONTRACT/,
  );
  if (!match?.[1]) throw new Error("Missing complete RLS policy contract markers.");
  return match[1].replace(/\r\n/g, "\n").trim();
}

describe("staging release migration contract", () => {
  it("uses the identical read-only preflight contract inside the atomic baseline", () => {
    const contract = compatibilityContract(preflight);
    expect(contract).toBe(compatibilityContract(baseline));
    expect(baseline.trimStart()).toMatch(/^BEGIN;/);
    expect(baseline.trimEnd()).toMatch(/COMMIT;$/);
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
    const columnRows = contract
      .split("-- Every scalar column in the schema", 2)[1]
      .split("-- Complete relationship contract", 1)[0]
      .match(/^      \('[^']+', '[^']+',/gm);
    const foreignKeyRows = contract
      .split("-- Complete relationship contract", 2)[1]
      .split("  FOR expected IN\n    SELECT * FROM (VALUES\n      ('Locale'", 1)[0]
      .match(/^      \('public', '[^']+', '[^']+_fkey',/gm);
    expect(columnRows).toHaveLength(469);
    expect(foreignKeyRows).toHaveLength(71);
  });

  it("fails closed on same-name tenant and storage policy drift", () => {
    expect(security.trimStart()).toMatch(/^BEGIN;/);
    expect(security.trimEnd()).toMatch(/COMMIT;$/);
    expect(security).toContain("assert_syveka_policy_contract");
    expect(security).toContain("universally true predicate");
    expect(security).not.toMatch(/DROP\s+POLICY/i);
    const rlsContract = rlsPolicyContract(security);
    expect(rlsContract).toBe(rlsPolicyContract(releaseInvariants));
    expect(rlsContract.match(/^      \('public',/gm)).toHaveLength(86);
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
