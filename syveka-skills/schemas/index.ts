import { z } from "zod";

/**
 * Core schemas for Syveka Master Skill. These are the shared contracts every
 * layer (core, providers, adapters) is built against - deliberately small
 * and boring. A provider or adapter that can't be expressed in these shapes
 * doesn't get to skip validation, it gets rejected.
 */

export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const registryStatusSchema = z.enum([
  "APPROVED",
  "EXPERIMENTAL",
  "REVIEW",
  "REJECTED",
  "RESEARCH_ONLY",
]);
export type RegistryStatus = z.infer<typeof registryStatusSchema>;

export const trustLevelSchema = z.enum(["TRUSTED", "CONDITIONAL", "UNTRUSTED"]);
export type TrustLevel = z.infer<typeof trustLevelSchema>;

/** A provider/skill registry entry - one row per capability implementation. */
export const registryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capability: z.string().min(1), // dotted capability id, e.g. "ui.component.search"
  provider: z.string().min(1),
  version: z.string().optional(),
  commit: z.string().optional(),
  source: z.string().min(1), // authoritative URL
  license: z.string().min(1),
  trust_level: trustLevelSchema,
  risk_level: riskLevelSchema,
  status: registryStatusSchema,
  supported_agents: z.array(z.string()),
  permissions: z.array(z.string()),
  network_access: z.boolean(),
  filesystem_access: z.boolean(),
  scripts: z.boolean(), // does it run scripts/subprocesses
  hooks: z.boolean(),
  dependencies: z.array(z.string()),
  credential_requirements: z.array(z.string()),
  approval_required: z.boolean(),
  installation_scope: z.enum(["none", "local", "container", "global"]),
  last_reviewed: z.string(), // ISO date
  last_updated: z.string(), // ISO date
  security_notes: z.string(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

export const evidenceItemSchema = z.object({
  type: z.enum([
    "test",
    "build",
    "log",
    "diff",
    "screenshot",
    "artifact",
    "source_reference",
    "ci_check",
    "database_query",
  ]),
  description: z.string().min(1),
  data: z.string(), // raw evidence content (truncated by callers as needed)
  timestamp: z.string(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const evidenceBundleSchema = z.object({
  claim: z.string().min(1),
  items: z.array(evidenceItemSchema),
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export const verificationStatusSchema = z.enum(["VERIFIED", "UNVERIFIED", "FAILED"]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const verificationResultSchema = z.object({
  status: verificationStatusSchema,
  reason: z.string(),
  evidence: evidenceBundleSchema,
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const approvalRequestSchema = z.object({
  requested_action: z.string().min(1),
  reason: z.string().min(1),
  risk: riskLevelSchema,
  expected_effect: z.string().min(1),
  rollback_plan: z.string().min(1),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const auditEventTypeSchema = z.enum([
  "task_received",
  "plan_created",
  "capability_selected",
  "provider_selected",
  "provider_unavailable",
  "permission_requested",
  "permission_granted",
  "permission_denied",
  "tool_executed",
  "artifact_created",
  "test_run",
  "verification_passed",
  "verification_failed",
  "report_generated",
]);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

export const auditEventSchema = z.object({
  type: auditEventTypeSchema,
  timestamp: z.string(),
  task_id: z.string(),
  data: z.record(z.unknown()), // must be pre-scrubbed by the caller - see core/reporting/scrub.ts
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const planStepSchema = z.object({
  capability: z.string().min(1),
  description: z.string().min(1),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planSchema = z.object({
  steps: z.array(planStepSchema).min(1),
});
export type Plan = z.infer<typeof planSchema>;

export const taskRequestSchema = z.object({
  id: z.string().min(1),
  request: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const providerResultStatusSchema = z.enum(["SUCCESS", "FAILURE", "UNAVAILABLE"]);
export type ProviderResultStatus = z.infer<typeof providerResultStatusSchema>;

export const providerResultSchema = z.object({
  status: providerResultStatusSchema,
  message: z.string(),
  evidence: z.array(evidenceItemSchema),
  data: z.unknown().optional(),
});
export type ProviderResult = z.infer<typeof providerResultSchema>;

export const taskReportSchema = z.object({
  task_id: z.string(),
  request: z.string(),
  plan: planSchema,
  verification: verificationResultSchema,
  status: z.enum(["COMPLETE", "UNVERIFIED", "FAILED", "BLOCKED", "CAPABILITY_UNAVAILABLE"]),
  summary: z.string(),
  audit_trail: z.array(auditEventSchema),
});
export type TaskReport = z.infer<typeof taskReportSchema>;
