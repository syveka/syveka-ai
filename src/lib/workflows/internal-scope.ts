/**
 * Internal-only workflow scope for an organization (Organization.settings flag
 * `workflow_steps_internal_only: true`, set by an operator for test or pilot
 * organizations). Such an organization's workflows may only use steps whose
 * effects stay inside Syveka:
 *
 * - condition: pure evaluation;
 * - crm.create_activity: writes a CRM activity in the organization;
 * - notify.member: writes an in-app notification to a member (no email).
 *
 * Refused: email.send (real email), ai.generate (paid model call),
 * wait.duration (delayed queue resume), and the schedule.cron trigger.
 *
 * The rule is enforced on save, activation, test runs and, last, in the
 * run-workflow job before any step executes, so a workflow saved before the
 * flag was set can't run either. Anything that isn't a recognisable list of
 * steps counts as a violation (fail closed).
 */
export const INTERNAL_ONLY_WORKFLOWS_FLAG = "workflow_steps_internal_only";

export const INTERNAL_STEP_TYPES: readonly string[] = [
  "condition",
  "crm.create_activity",
  "notify.member",
];

export const INTERNAL_EXCLUDED_TRIGGER_TYPES: readonly string[] = ["schedule.cron"];

/** The step and trigger types outside the internal scope; empty when allowed. */
export function internalScopeViolations(trigger: unknown, steps: unknown): string[] {
  const violations: string[] = [];
  const triggerType =
    trigger && typeof trigger === "object" ? (trigger as { type?: unknown }).type : undefined;
  if (typeof triggerType !== "string" || INTERNAL_EXCLUDED_TRIGGER_TYPES.includes(triggerType)) {
    violations.push(`trigger:${String(triggerType)}`);
  }
  if (!Array.isArray(steps)) return [...violations, "steps:invalid"];
  for (const step of steps) {
    const type = step && typeof step === "object" ? (step as { type?: unknown }).type : undefined;
    if (typeof type !== "string" || !INTERNAL_STEP_TYPES.includes(type)) {
      violations.push(`step:${String(type)}`);
    }
  }
  return [...new Set(violations)];
}
