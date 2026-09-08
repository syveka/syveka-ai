/**
 * Mandatory Phase 3 negative test (task brief): "Tenant A cannot execute
 * using Tenant B's connected account." Standalone, dependency-free, no
 * live Composio/Google call - proves the BINDING LOGIC itself, which is
 * the actual security boundary (the live API only ever sees whatever
 * connected_account_id our own server code decided to send it).
 *
 * Run: npx tsx scripts/poc/composio-calendar/tenant-binding.negative-test.ts
 */
import {
  TenantComposioConnectionRegistry,
  resolveConnectedAccountId,
  verifyConnectionOwnership,
  buildToolExecuteRequest,
  TenantBindingError,
  type TenantComposioConnection,
} from "./tenant-binding.js";

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

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

const registry = new TenantComposioConnectionRegistry();

const tenantA: TenantComposioConnection = {
  organizationId: "org-tenant-a",
  userId: "user-a-1",
  provider: "composio",
  toolkitSlug: "googlecalendar",
  composioConnectedAccountId: "ca_tenant_a_real_id",
  composioUserId: "syveka:org-tenant-a:user-a-1",
  status: "ACTIVE",
};

const tenantB: TenantComposioConnection = {
  organizationId: "org-tenant-b",
  userId: "user-b-1",
  provider: "composio",
  toolkitSlug: "googlecalendar",
  composioConnectedAccountId: "ca_tenant_b_real_id",
  composioUserId: "syveka:org-tenant-b:user-b-1",
  status: "ACTIVE",
};

registry.register(tenantA);
registry.register(tenantB);

console.log("=== Tenant binding negative-test suite ===\n");

check("resolves tenant A's own connection when given tenant A's server-verified identity", () => {
  const id = resolveConnectedAccountId(registry, { orgId: "org-tenant-a", userId: "user-a-1" });
  assertEqual(id, "ca_tenant_a_real_id", "resolved id");
});

check("resolves tenant B's own connection when given tenant B's server-verified identity", () => {
  const id = resolveConnectedAccountId(registry, { orgId: "org-tenant-b", userId: "user-b-1" });
  assertEqual(id, "ca_tenant_b_real_id", "resolved id");
});

check(
  "CRITICAL: tenant A's context can NEVER resolve to tenant B's connected_account_id, even implicitly",
  () => {
    const id = resolveConnectedAccountId(registry, { orgId: "org-tenant-a", userId: "user-a-1" });
    if (id === tenantB.composioConnectedAccountId) {
      throw new Error(
        "tenant A's context resolved to tenant B's connection id - CROSS-TENANT LEAK",
      );
    }
  },
);

check(
  "CRITICAL: a malicious/compromised agent tool-call payload naming tenant B's connected_account_id is IGNORED and overwritten with tenant A's own",
  () => {
    const maliciousAgentArgs = {
      calendarId: "primary",
      // An LLM/agent could, in principle, emit this key in its tool-call
      // JSON (prompt injection, a bug, or a compromised upstream model) -
      // the request builder must never trust it.
      connected_account_id: tenantB.composioConnectedAccountId,
      user_id: tenantB.composioUserId,
    };
    const request = buildToolExecuteRequest(
      registry,
      { orgId: "org-tenant-a", userId: "user-a-1" },
      maliciousAgentArgs,
    );
    assertEqual(
      request.connected_account_id,
      tenantA.composioConnectedAccountId,
      "server-resolved connected_account_id",
    );
    if ("connected_account_id" in request.arguments || "user_id" in request.arguments) {
      throw new Error(
        "agent-supplied connected_account_id/user_id survived into the sanitized arguments",
      );
    }
  },
);

check(
  "an org with no registered connection fails closed (throws), never returns a guessable/default id",
  () => {
    assertThrows(
      () =>
        resolveConnectedAccountId(registry, { orgId: "org-with-no-connection", userId: "nobody" }),
      TenantBindingError,
      "unregistered tenant",
    );
  },
);

check("a REVOKED connection fails closed even though a registry row still exists", () => {
  const revokedRegistry = new TenantComposioConnectionRegistry();
  revokedRegistry.register({ ...tenantA, status: "REVOKED" });
  assertThrows(
    () => resolveConnectedAccountId(revokedRegistry, { orgId: "org-tenant-a", userId: "user-a-1" }),
    TenantBindingError,
    "revoked connection",
  );
});

check(
  "identity cross-check rejects a connection whose Composio-reported user_id does not match the expected binding",
  () => {
    assertThrows(
      () => verifyConnectionOwnership("some-other-composio-user-id", tenantA),
      TenantBindingError,
      "identity mismatch",
    );
  },
);

check(
  "identity cross-check accepts a connection whose Composio-reported user_id matches exactly",
  () => {
    verifyConnectionOwnership(tenantA.composioUserId, tenantA);
  },
);

// --- Additional cases added for the custom-OAuth PoC hardening pass ---
// (See also scripts/poc/composio-calendar/lib/security-contract.test.ts for
// the tool-allowlist side of adversarial coverage - unauthorized tool
// identifiers are that module's concern, not tenant-binding's.)

check(
  "CRITICAL: a Composio dashboard-generated pg-test-* placeholder identity is never accepted as a tenant match",
  () => {
    // Live-observed shape (this PoC's own custom auth config once had a
    // dashboard "test connection" bound to exactly this kind of id instead
    // of the real TEST identity) - verifyConnectionOwnership must reject it
    // like any other mismatched user_id, with no special-casing.
    assertThrows(
      () => verifyConnectionOwnership("pg-test-9c297f51-091a-41b7-8a62-0775e62ba6d8", tenantA),
      TenantBindingError,
      "dashboard placeholder identity must be rejected",
    );
  },
);

check(
  "missing tenant context (empty org/user strings) fails closed, never resolves by accident",
  () => {
    assertThrows(
      () => resolveConnectedAccountId(registry, { orgId: "", userId: "" }),
      TenantBindingError,
      "empty org/user context",
    );
  },
);

check(
  "multi-tenant ambiguity: a third tenant's registration cannot leak into A or B's resolution",
  () => {
    const registryC = new TenantComposioConnectionRegistry();
    const tenantC: TenantComposioConnection = {
      organizationId: "org-tenant-c",
      userId: "user-c-1",
      provider: "composio",
      toolkitSlug: "googlecalendar",
      composioConnectedAccountId: "ca_tenant_c_real_id",
      composioUserId: "syveka:org-tenant-c:user-c-1",
      status: "ACTIVE",
    };
    registryC.register(tenantA);
    registryC.register(tenantB);
    registryC.register(tenantC);

    const idA = resolveConnectedAccountId(registryC, { orgId: "org-tenant-a", userId: "user-a-1" });
    const idB = resolveConnectedAccountId(registryC, { orgId: "org-tenant-b", userId: "user-b-1" });
    const idC = resolveConnectedAccountId(registryC, { orgId: "org-tenant-c", userId: "user-c-1" });
    assertEqual(
      idA,
      "ca_tenant_a_real_id",
      "tenant A resolves to its own id with 3 tenants registered",
    );
    assertEqual(
      idB,
      "ca_tenant_b_real_id",
      "tenant B resolves to its own id with 3 tenants registered",
    );
    assertEqual(
      idC,
      "ca_tenant_c_real_id",
      "tenant C resolves to its own id with 3 tenants registered",
    );
  },
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
