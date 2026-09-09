/**
 * Canonical connection-string sanitizer for scripts run via plain `node`
 * (validate-staging-config.mjs), which cannot import a .ts file the way
 * `tsx`-run scripts (ensure-e2e-org-fixture.ts) or the Next.js app bundle
 * can. This is an intentional, manually-synced mirror of
 * src/server/db/connection-string-sanitizer.ts -- see that file's header
 * comment for the full incident history (2026-08-28, staging run
 * 33961238272, staging run 33990035456) this fixes. Keep both in sync.
 */
export function sanitizeConnectionString(raw) {
  let value = raw.replace(/[\r\n]/g, "").trim();
  if (value.endsWith("?")) {
    value = value.slice(0, -1);
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}
