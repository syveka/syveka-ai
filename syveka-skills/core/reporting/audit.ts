import type { AuditEvent, AuditEventType } from "../../schemas/index.js";

const SECRET_KEY_PATTERN = /(key|token|secret|password|cookie|authorization)/i;

/**
 * Recursively strips any object key that looks credential-shaped before it
 * can reach an audit event. Applied unconditionally at the point events are
 * recorded (see AuditLog.record) - a caller cannot opt out of this by
 * passing "trusted" data, because there's no such thing as data trusted
 * enough to skip it. Per the product brief: "No secrets in audit logs."
 */
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

export class AuditLog {
  private events: AuditEvent[] = [];

  constructor(private readonly taskId: string) {}

  record(type: AuditEventType, data: Record<string, unknown> = {}): void {
    this.events.push({
      type,
      timestamp: new Date().toISOString(),
      task_id: this.taskId,
      data: scrub(data),
    });
  }

  all(): AuditEvent[] {
    return [...this.events];
  }
}
