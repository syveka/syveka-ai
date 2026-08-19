import { describe, expect, it } from "vitest";
import { routeCapability } from "../core/router/index.js";
import { createUnavailableStubProvider } from "../providers/unavailable-stub.js";
import { createSkillRegistryLookupProvider } from "../providers/skill-registry-lookup/index.js";
import type { Provider } from "../providers/types.js";

describe("capability routing", () => {
  it("routes a known, approved capability to its provider", async () => {
    const providerMap: Record<string, Provider> = {
      "skill-registry-lookup": createSkillRegistryLookupProvider(),
    };
    const route = await routeCapability("skill.discovery", providerMap);
    expect(route.outcome).toBe("ROUTED");
    if (route.outcome === "ROUTED") {
      expect(route.entry.provider).toBe("skill-registry-lookup");
    }
  });

  it("reports NO_APPROVED_PROVIDER for a capability with no registry entry at all", async () => {
    const route = await routeCapability("nonexistent.capability", {});
    expect(route.outcome).toBe("NO_APPROVED_PROVIDER");
  });

  it("reports PROVIDER_UNAVAILABLE (not a fabricated success) when an APPROVED capability's provider reports unavailable", async () => {
    // engineering.test's registry entry is APPROVED (so it's eligible for
    // routing), but the provider bound to it here is deliberately down -
    // this must surface as PROVIDER_UNAVAILABLE, not silently succeed.
    const providerMap: Record<string, Provider> = {
      "local-test-runner": createUnavailableStubProvider({
        id: "local-test-runner",
        reason: "not connected in this scenario",
      }),
    };
    const route = await routeCapability("engineering.test", providerMap);
    expect(route.outcome).toBe("PROVIDER_UNAVAILABLE");
  });

  it("reports NO_APPROVED_PROVIDER when the only registry candidate is still under review (not APPROVED yet)", async () => {
    // shadcn-mcp is status REVIEW in the seed registry - it must be
    // excluded from routing entirely, before provider availability is even
    // checked, regardless of whether a provider object exists for it.
    const providerMap: Record<string, Provider> = {
      shadcn: createUnavailableStubProvider({ id: "shadcn", reason: "not connected" }),
    };
    const route = await routeCapability("ui.component.provide", providerMap);
    expect(route.outcome).toBe("NO_APPROVED_PROVIDER");
  });

  it("never routes to a REJECTED registry entry even when it's the only candidate for a capability", async () => {
    // Simulates the case a real rejected skill claims a capability nothing
    // else serves - eligibleForRouting must exclude it regardless.
    const { eligibleForRouting } = await import("../core/registry/index.js");
    const rejectedOnly = [
      {
        id: "malicious-thing",
        name: "Malicious Thing",
        capability: "unique.capability.nobody.else.has",
        provider: "malicious-thing",
        source: "https://example.test/malicious",
        license: "unknown",
        trust_level: "UNTRUSTED" as const,
        risk_level: "HIGH" as const,
        status: "REJECTED" as const,
        integration_state: "INSTALLED" as const,
        supported_agents: [],
        permissions: [],
        network_access: true,
        filesystem_access: true,
        scripts: true,
        hooks: true,
        dependencies: [],
        credential_requirements: [],
        approval_required: true,
        installation_scope: "none" as const,
        last_reviewed: "2026-08-19",
        last_updated: "2026-08-19",
        security_notes: "Rejected during review - contains obfuscated postinstall script.",
      },
    ];
    expect(eligibleForRouting(rejectedOnly)).toHaveLength(0);
  });

  it("checks isAvailable() before routing rather than assuming a registered provider works", async () => {
    let checked = false;
    const providerMap: Record<string, Provider> = {
      "local-test-runner": {
        id: "local-test-runner",
        isAvailable: () => {
          checked = true;
          return true;
        },
        execute: async () => ({ status: "SUCCESS", message: "ok", evidence: [] }),
      },
    };
    const route = await routeCapability("engineering.test", providerMap);
    expect(route.outcome).toBe("ROUTED");
    expect(checked).toBe(true);
  });

  it("reports PROVIDER_UNAVAILABLE rather than fabricating ROUTED when the registered provider says it's down", async () => {
    const providerMap: Record<string, Provider> = {
      "local-test-runner": {
        id: "local-test-runner",
        isAvailable: () => false,
        execute: async () => ({ status: "UNAVAILABLE", message: "down", evidence: [] }),
      },
    };
    const route = await routeCapability("engineering.test", providerMap);
    expect(route.outcome).toBe("PROVIDER_UNAVAILABLE");
  });

  it("excludes an APPROVED entry whose integration_state is still REFERENCE, INSTALLED, or REVIEWED - status alone is not enough", async () => {
    // Found during independent adversarial review of PR #87/#88:
    // eligibleForRouting() originally only checked `status`, so an
    // APPROVED-but-never-built entry would have been treated as routable
    // if a provider ever happened to be wired into providerMap under its
    // id (e.g. a copy-paste mistake or premature wiring). integration_state
    // must be checked too, independently of status - see
    // docs/skills-registry.md "Integration state vs. review status".
    const { eligibleForRouting } = await import("../core/registry/index.js");
    const base = {
      id: "hypothetical-thing",
      name: "Hypothetical Thing",
      capability: "hypothetical.capability",
      provider: "hypothetical-thing",
      source: "https://example.test/hypothetical",
      license: "MIT",
      trust_level: "TRUSTED" as const,
      risk_level: "LOW" as const,
      status: "APPROVED" as const,
      supported_agents: [],
      permissions: [],
      network_access: false,
      filesystem_access: false,
      scripts: false,
      hooks: false,
      dependencies: [],
      credential_requirements: [],
      approval_required: false,
      installation_scope: "none" as const,
      last_reviewed: "2026-08-19",
      last_updated: "2026-08-19",
      security_notes:
        "APPROVED in principle - integration_state governs whether it's actually routable.",
    };

    for (const integration_state of ["REFERENCE", "REVIEWED", "INSTALLED"] as const) {
      const entries = [{ ...base, integration_state }];
      expect(
        eligibleForRouting(entries),
        `integration_state=${integration_state} must be excluded`,
      ).toHaveLength(0);
    }

    for (const integration_state of ["CONNECTED", "VERIFIED"] as const) {
      const entries = [{ ...base, integration_state }];
      expect(
        eligibleForRouting(entries),
        `integration_state=${integration_state} must be included`,
      ).toHaveLength(1);
    }
  });

  it("a REVIEW+VERIFIED entry is still excluded - status and integration_state are both required, neither alone is sufficient", async () => {
    const { eligibleForRouting } = await import("../core/registry/index.js");
    const entry = {
      id: "reviewed-but-not-approved",
      name: "Reviewed But Not Approved",
      capability: "some.capability",
      provider: "reviewed-but-not-approved",
      source: "https://example.test/x",
      license: "MIT",
      trust_level: "TRUSTED" as const,
      risk_level: "LOW" as const,
      status: "REVIEW" as const, // review not yet complete/approved
      integration_state: "VERIFIED" as const, // even though tests pass
      supported_agents: [],
      permissions: [],
      network_access: false,
      filesystem_access: false,
      scripts: false,
      hooks: false,
      dependencies: [],
      credential_requirements: [],
      approval_required: false,
      installation_scope: "none" as const,
      last_reviewed: "2026-08-19",
      last_updated: "2026-08-19",
      security_notes: "Passing tests does not substitute for a completed approval review.",
    };
    expect(eligibleForRouting([entry])).toHaveLength(0);
  });
});
