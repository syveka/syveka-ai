import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * TENANT_MODELS (src/server/db/tenant.ts) is intentionally not exported - it's a
 * private allowlist consumed only inside tenantDb()'s query interceptor, and this
 * test must not widen that module's public surface just to become testable. So we
 * read the source file's text and parse the literal `new Set<Prisma.ModelName>([...])`
 * out of it instead of importing the binding. If tenantDb() is ever refactored so this
 * declaration is renamed or reformatted, `extractTenantModels` below will throw with a
 * pointer to itself rather than silently reporting zero models.
 */
const TENANT_TS_PATH = resolve(process.cwd(), "src/server/db/tenant.ts");
const tenantSource = readFileSync(TENANT_TS_PATH, "utf8");

function extractTenantModels(source: string): string[] {
  const match = source.match(/const TENANT_MODELS = new Set<Prisma\.ModelName>\(\[([\s\S]*?)\]\)/);
  if (!match) {
    throw new Error(
      "Could not find `const TENANT_MODELS = new Set<Prisma.ModelName>([...])` in " +
        "src/server/db/tenant.ts - has the declaration been renamed or reformatted? " +
        "Update the regex in tests/unit/tenant-models-coverage.test.ts to match.",
    );
  }
  const names = [...match[1]!.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
  if (names.length === 0) {
    throw new Error(
      "Parsed zero model names out of TENANT_MODELS - the extraction regex in " +
        "tests/unit/tenant-models-coverage.test.ts is likely out of sync with tenant.ts's format.",
    );
  }
  return names;
}

/**
 * Models deliberately left out of TENANT_MODELS: scoped only via a parent relation
 * (per the comment at src/server/db/tenant.ts:13-16) or not an org-child model at all
 * (User, Organization). A new schema model must be added to exactly one of these two
 * lists - this test fails until it is.
 *
 * StripeWebhookEvent: keyed and queried exclusively by Stripe's own globally-unique
 * `stripeEventId`, never by organization - see the model's own doc comment in
 * prisma/schema.prisma and docs/stripe-webhook-reliability.md.
 *
 * Compliance domain (Issue #74, Phase 1): Syveka-platform-level security/compliance
 * posture, not tenant-owned data - gated by requireSuperadmin(), never scoped by
 * organization. See prisma/schema.prisma's own doc comment on this block and
 * docs/compliance/ARCHITECTURE.md.
 */
const DOCUMENTED_EXCLUSIONS = new Set([
  "Message",
  "PipelineStage",
  "DocumentChunk",
  "TagsOnContacts",
  "EventAttendee",
  "AvailabilityRule",
  "AvailabilityOverride",
  "BookingToken",
  "InboxMessage",
  "User",
  "Organization",
  "StripeWebhookEvent",
  "ComplianceControl",
  "ControlFrameworkMapping",
  "ComplianceEvidence",
  "ComplianceRisk",
  "SecurityPolicy",
  "PolicyAcknowledgement",
  "SecurityIncident",
  "IncidentEvent",
  "Subprocessor",
  "ProcessingRecord",
  "DataSubjectRequest",
  "DsrEvent",
  "RetentionPolicy",
  "RetentionExecution",
  "PrivacySecurityAssessment",
  "AccessReview",
  "Certification",
  "ComplianceAuditLog",
]);

describe("TENANT_MODELS coverage (src/server/db/tenant.ts)", () => {
  const tenantModels = extractTenantModels(tenantSource);
  const tenantModelSet = new Set(tenantModels);
  const schemaModels = Prisma.dmmf.datamodel.models.map((m) => m.name);
  const schemaModelSet = new Set(schemaModels);

  it("parsed a non-trivial TENANT_MODELS list from the source", () => {
    expect(tenantModels.length).toBeGreaterThan(0);
  });

  it("has no duplicate entries within TENANT_MODELS itself", () => {
    expect(tenantModels.length).toBe(tenantModelSet.size);
  });

  it("classifies every schema model in exactly one of TENANT_MODELS or DOCUMENTED_EXCLUSIONS", () => {
    const inBoth = schemaModels.filter(
      (model) => tenantModelSet.has(model) && DOCUMENTED_EXCLUSIONS.has(model),
    );
    const unclassified = schemaModels.filter(
      (model) => !tenantModelSet.has(model) && !DOCUMENTED_EXCLUSIONS.has(model),
    );

    expect(inBoth, "models present in both TENANT_MODELS and DOCUMENTED_EXCLUSIONS").toEqual([]);
    expect(
      unclassified,
      "schema models missing from both TENANT_MODELS and DOCUMENTED_EXCLUSIONS - " +
        "classify each as tenant-scoped (add to tenant.ts's TENANT_MODELS) or add it to " +
        "DOCUMENTED_EXCLUSIONS above with a reason",
    ).toEqual([]);
  });

  it("references no model in TENANT_MODELS that no longer exists in the schema", () => {
    const stale = tenantModels.filter((model) => !schemaModelSet.has(model));
    expect(stale).toEqual([]);
  });

  it("references no model in DOCUMENTED_EXCLUSIONS that no longer exists in the schema", () => {
    const stale = [...DOCUMENTED_EXCLUSIONS].filter((model) => !schemaModelSet.has(model));
    expect(stale).toEqual([]);
  });
});
