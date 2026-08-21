/**
 * Shared error-message redaction. Extracted from two independent,
 * byte-for-byte identical implementations (src/app/api/health/route.ts and
 * src/app/api/v1/webhooks/stripe/route.ts) found during a refactoring audit -
 * both existed to strip embedded connection-string/URL credentials before an
 * error reaches a log line or a persisted field, and both used the exact
 * same regex. Consolidated here so future call sites get this redaction for
 * free instead of needing to remember to reimplement it.
 */
export function sanitizeErrorMessage(err: unknown, maxLength: number): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, "[redacted-url]").slice(0, maxLength);
}
