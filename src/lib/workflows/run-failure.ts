/**
 * Why a workflow run failed or was canceled, as a fixed code the Run history
 * can translate. The run record and the creator's workflow.failed
 * notification keep the job's own text (failureText() limits it to step
 * messages and error names); Run history and the notifications page show
 * only the translated reason for its code.
 */
export const WORKFLOW_RUN_FAILURES = [
  "contact_missing_test_run",
  "contact_missing",
  "contact_not_found",
  "invalid_recipient",
  "ai_quota_exceeded",
  "step_not_allowed",
  "workflow_deactivated",
  "internal",
] as const;

export type WorkflowRunFailure = (typeof WORKFLOW_RUN_FAILURES)[number];

/** Step errors written by the run-workflow job for the workflow's creator. */
export const CONTACT_MISSING_TEST_RUN_ERROR =
  "crm.create_activity: a test run has no trigger data, so no contact";
export const CONTACT_MISSING_ERROR = "crm.create_activity: no contact in the contact field";
export const CONTACT_NOT_FOUND_ERROR = "crm.create_activity: contact not found";
export const INVALID_RECIPIENT_ERROR_PREFIX = "email.send: invalid recipient";

/**
 * Run errors that end the job without a retry (the run-workflow job answers
 * 200): a step error the same input reproduces on every attempt, or a
 * refusal. A FAILED run with one of these stays FAILED when its message is
 * delivered again; any other FAILED run (a provider or database error, a
 * crash, a legacy row) stays reclaimable so a retry can still succeed.
 */
export const TERMINAL_RUN_ERRORS = {
  exact: [
    CONTACT_MISSING_TEST_RUN_ERROR,
    CONTACT_MISSING_ERROR,
    CONTACT_NOT_FOUND_ERROR,
    "ai_quota_exceeded",
  ],
  prefixes: [INVALID_RECIPIENT_ERROR_PREFIX],
} as const;

export function isTerminalRunError(error: string | null): boolean {
  if (!error) return false;
  return (
    (TERMINAL_RUN_ERRORS.exact as readonly string[]).includes(error) ||
    TERMINAL_RUN_ERRORS.prefixes.some((prefix) => error.startsWith(prefix))
  );
}

export function workflowRunFailure(error: string | null): WorkflowRunFailure | null {
  if (!error) return null;
  if (error === CONTACT_MISSING_TEST_RUN_ERROR) return "contact_missing_test_run";
  if (error === CONTACT_MISSING_ERROR) return "contact_missing";
  if (error === CONTACT_NOT_FOUND_ERROR) return "contact_not_found";
  if (error.startsWith(INVALID_RECIPIENT_ERROR_PREFIX)) return "invalid_recipient";
  if (error === "ai_quota_exceeded" || error === "step_not_allowed") return error;
  if (error === "workflow_deactivated") return error;
  return "internal";
}
