import { z } from "zod";

/**
 * Contract for "security.dependency_audit" - the first SecureShip
 * capability (see docs/secureship.md). Covers Inspect -> Detect ->
 * Prioritize -> Explain -> Report only; Fix/Test/Verify are deliberately
 * out of scope for this slice (see docs/secureship.md "What remains
 * intentionally unimplemented").
 *
 * Unlike voice-pilot/call-summary, this capability is repo/workspace-scoped,
 * not customer-data-scoped: it inspects package metadata already public in
 * the repository's own lockfile, never a tenant's private data. `tenant_ref`
 * is therefore optional, attribution-only, and never fail-closed-enforced -
 * see docs/secureship.md "Why tenant enforcement does not apply here".
 */

export const dependencyEcosystemSchema = z.enum(["npm"]);
export type DependencyEcosystem = z.infer<typeof dependencyEcosystemSchema>;

export const dependencySeveritySchema = z.enum(["info", "low", "moderate", "high", "critical"]);
export type DependencySeverity = z.infer<typeof dependencySeveritySchema>;

export const dependencyClassificationSchema = z.enum(["direct", "transitive"]);
export type DependencyClassification = z.infer<typeof dependencyClassificationSchema>;

export const overallRiskSchema = z.enum(["none", "info", "low", "moderate", "high", "critical"]);
export type OverallRisk = z.infer<typeof overallRiskSchema>;

/** Caller-supplied policy overrides - all optional, all defaulted by the provider. */
export const dependencyAuditPolicySchema = z
  .object({
    minimum_severity: dependencySeveritySchema.optional(),
    production_only: z.boolean().optional(),
    max_findings: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type DependencyAuditPolicy = z.infer<typeof dependencyAuditPolicySchema>;

/**
 * `workspace_ref` is a descriptive label for evidence/audit purposes only -
 * it never selects or overrides which filesystem path is scanned (that is
 * fixed at provider-construction time, like `local-test-runner`'s `cwd` -
 * see providers/dependency-audit/index.ts). The regex keeps it from ever
 * being useful as a path/command fragment even though spawnSync's argv-array
 * form already makes shell injection structurally impossible.
 */
export const dependencyAuditInputSchema = z
  .object({
    workspace_ref: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, "workspace_ref must be a simple label"),
    tenant_ref: z.string().min(1).max(200).optional(),
    ecosystem: dependencyEcosystemSchema,
    policy: dependencyAuditPolicySchema.optional(),
  })
  .strict();
export type DependencyAuditInput = z.infer<typeof dependencyAuditInputSchema>;

export const dependencyAuditFindingSchema = z
  .object({
    package: z.string().min(1),
    installed_version: z.string().min(1).nullable(),
    affected_range: z.string().min(1),
    severity: dependencySeveritySchema,
    advisory_id: z.string().min(1).nullable(),
    advisory_url: z.string().min(1).nullable(),
    title: z.string().min(1).max(500),
    classification: dependencyClassificationSchema,
    fix_available: z.boolean(),
    recommended_action: z.string().min(1).max(500),
    evidence_ref: z.string().min(1),
    cwe: z.array(z.string()).max(20),
    cvss_score: z.number().min(0).max(10).nullable(),
  })
  .strict();
export type DependencyAuditFinding = z.infer<typeof dependencyAuditFindingSchema>;

export const dependencyRiskSummarySchema = z
  .object({
    total_findings: z.number().int().nonnegative(),
    by_severity: z
      .object({
        info: z.number().int().nonnegative(),
        low: z.number().int().nonnegative(),
        moderate: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        critical: z.number().int().nonnegative(),
      })
      .strict(),
    direct_count: z.number().int().nonnegative(),
    transitive_count: z.number().int().nonnegative(),
    fixable_count: z.number().int().nonnegative(),
    overall_risk: overallRiskSchema,
  })
  .strict();
export type DependencyRiskSummary = z.infer<typeof dependencyRiskSummarySchema>;

/** Minimum output contract: Inspect/Detect/Prioritize/Explain/Report - no fix/test/verify fields. */
export const dependencyAuditOutputSchema = z
  .object({
    ecosystem: dependencyEcosystemSchema,
    scanned_dependency_count: z.number().int().nonnegative(),
    findings: z.array(dependencyAuditFindingSchema).max(500),
    risk_summary: dependencyRiskSummarySchema,
    truncated: z.boolean(),
  })
  .strict();
export type DependencyAuditOutput = z.infer<typeof dependencyAuditOutputSchema>;

export const dependencyAuditExecutionMetaSchema = z
  .object({
    skill: z.literal("secureship/dependency-audit"),
    skill_version: z.string().min(1),
    tenant_ref: z.string().nullable(),
    provider: z.string().min(1),
    ecosystem: dependencyEcosystemSchema,
    workspace_ref: z.string().min(1),
    tool_version: z.string().nullable(),
    started_at: z.string(),
    ended_at: z.string(),
    duration_ms: z.number().nonnegative(),
    status: z.enum(["success", "failure"]),
    error_classification: z
      .enum([
        "none",
        "validation_error",
        "tool_unavailable",
        "scanner_output_invalid",
        "internal_error",
      ])
      .default("none"),
  })
  .strict();
export type DependencyAuditExecutionMeta = z.infer<typeof dependencyAuditExecutionMetaSchema>;

export const dependencyAuditResultSchema = z
  .object({
    output: dependencyAuditOutputSchema,
    meta: dependencyAuditExecutionMetaSchema,
  })
  .strict();
export type DependencyAuditResult = z.infer<typeof dependencyAuditResultSchema>;
