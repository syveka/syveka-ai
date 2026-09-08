/**
 * Safe audit record shape for Calendar PoC operations, mirroring the
 * pattern already established in syveka-skills/core/reporting/audit.ts
 * (unconditional key-name-based secret scrubbing applied at the point a
 * record is created - a caller cannot opt out by claiming its data is
 * "trusted"). Reimplemented standalone here rather than imported, since
 * syveka-skills is a separate npm workspace with its own package.json/
 * tsconfig - this keeps the PoC's scripts/ tree dependency-free.
 *
 * An audit record captures only what's needed to answer "who did what, to
 * which calendar/event, did it succeed" - never credentials, tokens, or
 * event content beyond an id/status.
 */

const SECRET_KEY_PATTERN = /(key|token|secret|password|cookie|authorization|credential)/i;

/** Recursively redacts any object key that looks credential-shaped. */
export function scrub(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = scrub(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type CalendarOperation =
  "listEvents" | "createEvent" | "getEvent" | "deleteEvent" | "resolveConnection";

export interface CalendarAuditRecordInput {
  tenantOrgId: string;
  tenantUserId: string;
  operation: CalendarOperation;
  toolSlug?: string;
  connectedAccountId?: string;
  calendarId?: string;
  eventId?: string;
  success: boolean;
  errorClass?: string;
  durationMs: number;
}

export interface CalendarAuditRecord extends CalendarAuditRecordInput {
  timestamp: string;
}

// Fields explicitly excluded even if a caller tries to pass them - not just
// caught by scrub()'s key-name heuristic, but structurally impossible to
// include, since CalendarAuditRecordInput's type has no field for them.
// (No `description`, `attendees`, `rawResponse`, `accessToken`, etc.)

export class CalendarAuditLog {
  private records: CalendarAuditRecord[] = [];

  record(input: CalendarAuditRecordInput): CalendarAuditRecord {
    const scrubbed = scrub(
      input as unknown as Record<string, unknown>,
    ) as unknown as CalendarAuditRecordInput;
    const entry: CalendarAuditRecord = { ...scrubbed, timestamp: new Date().toISOString() };
    this.records.push(entry);
    return entry;
  }

  all(): CalendarAuditRecord[] {
    return [...this.records];
  }
}

/**
 * Wraps an operation with timing + audit recording. The wrapped function's
 * return value is used only to determine success/errorClass (via
 * `classify`) - its full result is never itself logged, only what
 * `classify` explicitly extracts.
 */
export async function withAudit<T>(
  log: CalendarAuditLog,
  meta: Omit<CalendarAuditRecordInput, "success" | "errorClass" | "durationMs">,
  fn: () => Promise<T>,
  classify: (result: T) => { success: boolean; errorClass?: string },
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const { success, errorClass } = classify(result);
    log.record({ ...meta, success, errorClass, durationMs: Date.now() - start });
    return result;
  } catch (err) {
    log.record({
      ...meta,
      success: false,
      errorClass: err instanceof Error ? err.name : "UNKNOWN_ERROR",
      durationMs: Date.now() - start,
    });
    throw err;
  }
}
