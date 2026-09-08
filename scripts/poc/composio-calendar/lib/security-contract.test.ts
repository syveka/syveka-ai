/**
 * Standalone, dependency-free test suite for security-contract.ts, matching
 * the style of tenant-binding.negative-test.ts elsewhere in this PoC (no
 * vitest dependency - root vitest.config.ts only discovers tests/unit/**,
 * so PoC-local tests run via tsx directly, same as every other test file in
 * this tree).
 *
 * Run: npx tsx scripts/poc/composio-calendar/lib/security-contract.test.ts
 */
import {
  checkScopes,
  checkExecutionAllowlist,
  assertToolApproved,
  assertAuthConfigContract,
  assertTenantBindingContract,
  SecurityContractViolation,
  APPROVED_SCOPES,
  APPROVED_TOOL_SLUGS,
} from "./security-contract.js";

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${(err as Error).message}`);
  }
}

function assertTrue(actual: boolean, msg: string): void {
  if (!actual) throw new Error(`expected true - ${msg}`);
}

function assertFalse(actual: boolean, msg: string): void {
  if (actual) throw new Error(`expected false - ${msg}`);
}

function assertThrows(
  fn: () => void,
  ErrorClass: new (...args: never[]) => Error,
  msg: string,
): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ErrorClass) return;
    throw new Error(`${msg} - threw wrong error type: ${(err as Error).constructor.name}`);
  }
  throw new Error(`${msg} - did not throw`);
}

function assertNoThrow(fn: () => void, msg: string): void {
  try {
    fn();
  } catch (err) {
    throw new Error(`${msg} - threw unexpectedly: ${(err as Error).message}`);
  }
}

console.log("=== security-contract.ts test suite ===\n");

check("checkScopes: PASS on exactly the two approved scopes, clean array", () => {
  const result = checkScopes([...APPROVED_SCOPES]);
  assertTrue(result.ok, "clean approved scope array");
  assertTrue(result.violations.length === 0, "no violations expected");
});

check("checkScopes: FAIL when full calendar scope is present", () => {
  const result = checkScopes([
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
  ]);
  assertFalse(result.ok, "full calendar scope must fail");
  assertTrue(
    result.violations.some((v) => v.includes("forbidden full calendar scope")),
    "expected a forbidden-full-scope violation",
  );
});

check("checkScopes: FAIL when Gmail scope appears", () => {
  const result = checkScopes([
    ...APPROVED_SCOPES,
    "https://www.googleapis.com/auth/gmail.readonly",
  ]);
  assertFalse(result.ok, "gmail scope must fail");
  assertTrue(
    result.violations.some((v) => v.includes("forbidden non-Calendar scope")),
    "expected a forbidden-non-calendar violation",
  );
});

check("checkScopes: FAIL when Drive scope appears", () => {
  const result = checkScopes([...APPROVED_SCOPES, "https://www.googleapis.com/auth/drive"]);
  assertFalse(result.ok, "drive scope must fail");
});

check(
  "checkScopes: FAIL when a generic unapproved-but-otherwise-valid Calendar scope appears",
  () => {
    // Distinct from the full/gmail/drive/contacts cases above: a real, valid
    // Google Calendar scope that just isn't one of our two approved ones -
    // must still be rejected as an extra scope, not silently tolerated
    // because it "looks like" a Calendar scope.
    const result = checkScopes([
      ...APPROVED_SCOPES,
      "https://www.googleapis.com/auth/calendar.settings.readonly",
    ]);
    assertFalse(result.ok, "unapproved extra Calendar scope must fail");
    assertTrue(
      result.violations.some((v) => v.includes("unapproved extra scope present")),
      "expected an unapproved-extra-scope violation",
    );
  },
);

check("checkScopes: FAIL when Contacts scope appears", () => {
  const result = checkScopes([...APPROVED_SCOPES, "https://www.googleapis.com/auth/contacts"]);
  assertFalse(result.ok, "contacts scope must fail");
});

check("checkScopes: FAIL when a required scope is missing", () => {
  const result = checkScopes(["https://www.googleapis.com/auth/calendar.events"]);
  assertFalse(result.ok, "missing calendar.calendars.readonly must fail");
  assertTrue(
    result.violations.some((v) => v.includes("missing required scope")),
    "expected a missing-scope violation",
  );
});

check("checkScopes: FAIL when a scope is duplicated", () => {
  const result = checkScopes([...APPROVED_SCOPES, APPROVED_SCOPES[0]]);
  assertFalse(result.ok, "duplicate scope must fail");
  assertTrue(
    result.violations.some((v) => v.includes("duplicate scope entry")),
    "expected a duplicate violation",
  );
});

check("checkScopes: FAIL on a malformed space-joined scope entry (live-observed shape)", () => {
  const result = checkScopes([
    "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendars.readonly",
  ]);
  assertFalse(result.ok, "space-joined entry must fail");
  assertTrue(
    result.violations.some((v) => v.includes("malformed space-joined scope entry")),
    "expected a malformed-entry violation",
  );
});

check("checkScopes: FAIL when scopes value is missing entirely", () => {
  assertFalse(checkScopes(null).ok, "null scopes must fail");
  assertFalse(checkScopes(undefined).ok, "undefined scopes must fail");
  assertFalse(checkScopes([]).ok, "empty array scopes must fail");
});

check("checkExecutionAllowlist: PASS on exactly the four approved tools", () => {
  const result = checkExecutionAllowlist([...APPROVED_TOOL_SLUGS]);
  assertTrue(result.ok, "clean approved allowlist");
  assertTrue(result.missing.length === 0 && result.extra.length === 0, "0 missing / 0 extra");
});

check("checkExecutionAllowlist: FAIL when allowlist is empty", () => {
  const result = checkExecutionAllowlist([]);
  assertFalse(result.ok, "empty allowlist must fail");
  assertTrue(
    result.violations.some((v) => v.includes("empty")),
    "expected an empty-allowlist violation",
  );
});

check("checkExecutionAllowlist: FAIL when an unapproved tool is present", () => {
  const result = checkExecutionAllowlist([...APPROVED_TOOL_SLUGS, "GOOGLECALENDAR_EVENTS_PATCH"]);
  assertFalse(result.ok, "extra tool must fail");
  assertTrue(result.extra.includes("GOOGLECALENDAR_EVENTS_PATCH"), "extra tool identified");
});

check("checkExecutionAllowlist: FAIL when a required tool is missing", () => {
  const result = checkExecutionAllowlist(["GOOGLECALENDAR_EVENTS_LIST"]);
  assertFalse(result.ok, "missing 3 tools must fail");
  assertTrue(result.missing.length === 3, "3 tools should be reported missing");
});

check("assertToolApproved: does not throw for an approved tool", () => {
  assertNoThrow(() => assertToolApproved("GOOGLECALENDAR_EVENTS_LIST"), "approved tool");
});

check(
  "assertToolApproved: CRITICAL - throws for any tool identifier outside the four approved",
  () => {
    assertThrows(
      () => assertToolApproved("GOOGLECALENDAR_CALENDARS_DELETE"),
      SecurityContractViolation,
      "unauthorized tool identifier",
    );
    assertThrows(
      () => assertToolApproved("GMAIL_SEND_EMAIL"),
      SecurityContractViolation,
      "tool from an unrelated toolkit",
    );
  },
);

check("assertAuthConfigContract: does not throw for a fully compliant config", () => {
  assertNoThrow(
    () =>
      assertAuthConfigContract({
        authConfigId: "ac_test",
        status: "ENABLED",
        isComposioManaged: false,
        scopes: [...APPROVED_SCOPES],
        executionAllowlist: [...APPROVED_TOOL_SLUGS],
      }),
    "compliant custom auth config",
  );
});

check(
  "assertAuthConfigContract: CRITICAL - rejects a Composio-managed auth config outright",
  () => {
    assertThrows(
      () =>
        assertAuthConfigContract({
          authConfigId: "ac_managed",
          status: "ENABLED",
          isComposioManaged: true,
          scopes: [...APPROVED_SCOPES],
          executionAllowlist: [...APPROVED_TOOL_SLUGS],
        }),
      SecurityContractViolation,
      "managed auth config must be rejected regardless of its scopes/allowlist",
    );
  },
);

check("assertAuthConfigContract: rejects a disabled auth config", () => {
  assertThrows(
    () =>
      assertAuthConfigContract({
        authConfigId: "ac_test",
        status: "DISABLED",
        isComposioManaged: false,
        scopes: [...APPROVED_SCOPES],
        executionAllowlist: [...APPROVED_TOOL_SLUGS],
      }),
    SecurityContractViolation,
    "disabled config must be rejected",
  );
});

check(
  "assertAuthConfigContract: CRITICAL - rejects the wrong auth config even if its content otherwise looks compliant",
  () => {
    assertThrows(
      () =>
        assertAuthConfigContract({
          authConfigId: "ac_unexpected_but_otherwise_valid",
          expectedAuthConfigId: "ac_the_one_we_actually_approved",
          status: "ENABLED",
          isComposioManaged: false,
          scopes: [...APPROVED_SCOPES],
          executionAllowlist: [...APPROVED_TOOL_SLUGS],
        }),
      SecurityContractViolation,
      "an auth config id mismatch must be rejected regardless of otherwise-valid content",
    );
  },
);

check("assertAuthConfigContract: does not throw when expectedAuthConfigId matches exactly", () => {
  assertNoThrow(
    () =>
      assertAuthConfigContract({
        authConfigId: "ac_test",
        expectedAuthConfigId: "ac_test",
        status: "ENABLED",
        isComposioManaged: false,
        scopes: [...APPROVED_SCOPES],
        executionAllowlist: [...APPROVED_TOOL_SLUGS],
      }),
    "matching expected id must pass",
  );
});

check("assertTenantBindingContract: does not throw for an exact, active match", () => {
  assertNoThrow(
    () =>
      assertTenantBindingContract({
        expectedComposioUserId: "syveka:org-test-poc:user-test-poc",
        reportedUserId: "syveka:org-test-poc:user-test-poc",
        connectionStatus: "ACTIVE",
      }),
    "exact tenant match",
  );
});

check(
  "assertTenantBindingContract: CRITICAL - rejects a Composio dashboard pg-test-* placeholder identity",
  () => {
    assertThrows(
      () =>
        assertTenantBindingContract({
          expectedComposioUserId: "syveka:org-test-poc:user-test-poc",
          reportedUserId: "pg-test-9c297f51-091a-41b7-8a62-0775e62ba6d8",
          connectionStatus: "ACTIVE",
        }),
      SecurityContractViolation,
      "dashboard placeholder identity must never be accepted as a tenant match",
    );
  },
);

check("assertTenantBindingContract: rejects a mismatched tenant even if ACTIVE", () => {
  assertThrows(
    () =>
      assertTenantBindingContract({
        expectedComposioUserId: "syveka:org-test-poc:user-test-poc",
        reportedUserId: "syveka:org-other-tenant:user-other",
        connectionStatus: "ACTIVE",
      }),
    SecurityContractViolation,
    "wrong tenant must be rejected",
  );
});

check("assertTenantBindingContract: rejects a correctly-bound but non-ACTIVE connection", () => {
  assertThrows(
    () =>
      assertTenantBindingContract({
        expectedComposioUserId: "syveka:org-test-poc:user-test-poc",
        reportedUserId: "syveka:org-test-poc:user-test-poc",
        connectionStatus: "EXPIRED",
      }),
    SecurityContractViolation,
    "expired connection must be rejected even with correct user_id",
  );
});

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
