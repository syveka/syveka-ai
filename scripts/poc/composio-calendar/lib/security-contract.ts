/**
 * The Google Calendar PoC's security contract, codified so it cannot drift
 * silently: the exact OAuth scope set and exact tool-execution allowlist
 * this integration is allowed to operate under, plus deterministic,
 * fail-closed validators any caller (the calendar service, the live smoke
 * harness, future code) must run before trusting a live auth config or
 * connected account.
 *
 * Nothing here calls Composio or Google - it is pure validation logic over
 * data the caller already has, so it can be unit-tested without network
 * access and reused anywhere this PoC's boundaries need enforcing.
 */

export const APPROVED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
] as const;

export const APPROVED_TOOL_SLUGS = [
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_EVENTS_LIST",
] as const;

export type ApprovedTool = (typeof APPROVED_TOOL_SLUGS)[number];

// Any scope containing these substrings is unconditionally rejected, even if
// it were somehow also present alongside an approved scope - defense in
// depth against a config that "approves" a broad scope by including a
// narrow one alongside it.
const FORBIDDEN_SCOPE_SUBSTRINGS = [
  "googleapis.com/auth/gmail",
  "googleapis.com/auth/drive",
  "googleapis.com/auth/contacts",
] as const;

// The one specific Calendar scope this contract must always reject: the
// full, unscoped calendar grant. Checked as an exact match, not a substring,
// since "calendar.events" and "calendar.calendars.readonly" both legitimately
// contain "calendar" as a prefix.
const FULL_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

export class SecurityContractViolation extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SecurityContractViolation";
  }
}

export interface ScopeCheckResult {
  ok: boolean;
  violations: string[];
}

/**
 * Validates a raw scopes value exactly as Composio/Google might return it -
 * which this PoC has empirically found can be malformed (a single array
 * element containing multiple scopes space-joined, duplicate entries, a
 * plain space/comma-joined string instead of an array). Every malformed
 * shape below is treated as a violation, not silently "fixed" - a caller
 * must see and correct the underlying config, not have this function paper
 * over it.
 */
export function checkScopes(rawScopes: unknown): ScopeCheckResult {
  const violations: string[] = [];

  if (rawScopes == null) {
    return { ok: false, violations: ["scopes value is missing (null/undefined)"] };
  }

  const rawEntries: string[] = Array.isArray(rawScopes)
    ? rawScopes.filter((s): s is string => typeof s === "string")
    : typeof rawScopes === "string"
      ? [rawScopes]
      : [];

  if (rawEntries.length === 0) {
    return { ok: false, violations: ["scopes value contained no string entries"] };
  }

  // A clean entry is a single URL with no internal whitespace. Anything else
  // (space-joined multi-scope strings) is flagged explicitly rather than
  // silently split and accepted - the config itself must be clean.
  for (const entry of rawEntries) {
    if (/\s/.test(entry)) {
      violations.push(`malformed space-joined scope entry: "${entry}"`);
    }
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of rawEntries) {
    if (seen.has(entry)) duplicates.add(entry);
    seen.add(entry);
  }
  for (const dup of duplicates) {
    violations.push(`duplicate scope entry: "${dup}"`);
  }

  for (const entry of rawEntries) {
    if (entry === FULL_CALENDAR_SCOPE) {
      violations.push(`forbidden full calendar scope present: "${entry}"`);
    }
    if (FORBIDDEN_SCOPE_SUBSTRINGS.some((s) => entry.includes(s))) {
      violations.push(`forbidden non-Calendar scope present: "${entry}"`);
    }
  }

  const approvedSet = new Set<string>(APPROVED_SCOPES);
  const entrySet = new Set(rawEntries);
  const missing = APPROVED_SCOPES.filter((s) => !entrySet.has(s));
  const extra = rawEntries.filter((s) => !approvedSet.has(s) && !/\s/.test(s));

  for (const m of missing) violations.push(`missing required scope: "${m}"`);
  for (const e of extra) violations.push(`unapproved extra scope present: "${e}"`);

  return { ok: violations.length === 0, violations };
}

export interface AllowlistCheckResult {
  ok: boolean;
  violations: string[];
  missing: string[];
  extra: string[];
}

/** Validates a tool-execution allowlist against the exact 4 approved tools. */
export function checkExecutionAllowlist(rawAllowlist: unknown): AllowlistCheckResult {
  const violations: string[] = [];
  const entries: string[] = Array.isArray(rawAllowlist)
    ? rawAllowlist.filter((s): s is string => typeof s === "string")
    : [];

  if (entries.length === 0) {
    violations.push("execution allowlist is empty");
  }

  const approvedSet = new Set<string>(APPROVED_TOOL_SLUGS);
  const entrySet = new Set(entries);
  const missing = APPROVED_TOOL_SLUGS.filter((t) => !entrySet.has(t));
  const extra = entries.filter((t) => !approvedSet.has(t as ApprovedTool));

  for (const m of missing) violations.push(`missing required tool: "${m}"`);
  for (const e of extra) violations.push(`unapproved extra tool present: "${e}"`);

  return { ok: violations.length === 0, violations, missing, extra };
}

/** Fail-closed variant of checkExecutionAllowlist: throws instead of returning a result. */
export function assertToolApproved(toolSlug: string): asserts toolSlug is ApprovedTool {
  if (!(APPROVED_TOOL_SLUGS as readonly string[]).includes(toolSlug)) {
    throw new SecurityContractViolation(
      `Tool "${toolSlug}" is not in the approved execution allowlist (${APPROVED_TOOL_SLUGS.join(", ")}).`,
      "UNAUTHORIZED_TOOL",
    );
  }
}

export interface AuthConfigContractCheck {
  authConfigId: string;
  status: unknown;
  isComposioManaged: unknown;
  scopes: unknown;
  executionAllowlist: unknown;
}

export interface ContractCheckResult {
  ok: boolean;
  violations: string[];
}

/**
 * Full fail-closed check of an auth config against this PoC's security
 * contract: must be a customer-owned (non-managed) config, ENABLED, with
 * exactly the approved scopes and exactly the approved execution allowlist.
 * Composio-managed configs are rejected outright (see
 * docs/skills/composio-calendar-poc.md - the managed shared OAuth client
 * cannot request calendar.calendars.readonly at all).
 */
export function assertAuthConfigContract(check: AuthConfigContractCheck): void {
  const violations: string[] = [];

  if (check.status !== "ENABLED") {
    violations.push(`auth config status is "${String(check.status)}", expected "ENABLED"`);
  }
  if (check.isComposioManaged !== false) {
    violations.push(
      "auth config is Composio-managed, not a customer-owned custom auth config - rejected " +
        "(the shared managed OAuth client cannot request calendar.calendars.readonly)",
    );
  }

  const scopeResult = checkScopes(check.scopes);
  violations.push(...scopeResult.violations);

  const allowlistResult = checkExecutionAllowlist(check.executionAllowlist);
  violations.push(...allowlistResult.violations);

  if (violations.length > 0) {
    throw new SecurityContractViolation(
      `Auth config ${check.authConfigId} failed the security contract:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
      "AUTH_CONFIG_CONTRACT_VIOLATION",
    );
  }
}

export interface TenantBindingContractCheck {
  expectedComposioUserId: string;
  reportedUserId: unknown;
  connectionStatus: unknown;
}

const ACTIVE_CONNECTION_STATUSES = new Set(["ACTIVE", "CONNECTED"]);

/**
 * Fail-closed check that a connected account both reports an ACTIVE-equivalent
 * status AND is bound to exactly the expected tenant identity. Rejects, among
 * other things, Composio dashboard-generated placeholder identities (the
 * `pg-test-*` shape observed live in this PoC) - any user_id that isn't a
 * byte-for-byte match to the expected identity is a violation, with no
 * special-casing for how it was created.
 */
export function assertTenantBindingContract(check: TenantBindingContractCheck): void {
  const violations: string[] = [];

  if (
    typeof check.connectionStatus !== "string" ||
    !ACTIVE_CONNECTION_STATUSES.has(check.connectionStatus)
  ) {
    violations.push(
      `connection status is "${String(check.connectionStatus)}", expected one of ${[...ACTIVE_CONNECTION_STATUSES].join("/")}`,
    );
  }

  if (check.reportedUserId !== check.expectedComposioUserId) {
    violations.push(
      `connection user_id "${String(check.reportedUserId)}" does not exactly match the expected ` +
        `tenant identity "${check.expectedComposioUserId}"`,
    );
  }

  if (violations.length > 0) {
    throw new SecurityContractViolation(
      `Tenant binding contract violated:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
      "TENANT_BINDING_CONTRACT_VIOLATION",
    );
  }
}
