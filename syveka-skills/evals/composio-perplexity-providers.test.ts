import { describe, expect, it } from "vitest";
import { composioProvider } from "../providers/composio/index.js";
import { perplexityProvider } from "../providers/perplexity/index.js";
import { routeCapability } from "../core/router/index.js";
import { findByCapability, findById } from "../core/registry/index.js";

/**
 * Composio and Perplexity are both REVIEW/REFERENCE entries (see
 * core/registry/data.ts) - registered for visibility and discovery, deliberately not
 * routable. These evals prove that in code, the same way evals/provider-availability.test.ts
 * and evals/capability-routing.test.ts prove it for shadcn-mcp/twentyfirst-dev/claude-video,
 * rather than trusting the registry's `status` field alone.
 */
describe("Composio stub provider", () => {
  it("honestly reports unavailable rather than pretending to work", async () => {
    expect(await composioProvider.isAvailable()).toBe(false);
    const result = await composioProvider.execute({});
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.message).toContain("Composio");
  });

  it("is registered under capability integration.gateway at status REVIEW", () => {
    const entry = findById("composio");
    expect(entry?.capability).toBe("integration.gateway");
    expect(entry?.status).toBe("REVIEW");
    expect(entry?.integration_state).toBe("REFERENCE");
  });

  it("is never routed to, even when explicitly wired into the providerMap", async () => {
    const route = await routeCapability("integration.gateway", { composio: composioProvider });
    expect(route.outcome).toBe("NO_APPROVED_PROVIDER");
  });
});

describe("Perplexity stub provider", () => {
  it("honestly reports unavailable rather than pretending to work", async () => {
    expect(await perplexityProvider.isAvailable()).toBe(false);
    const result = await perplexityProvider.execute({});
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.message).toContain("Perplexity");
  });

  it("is registered under capability research.cited at status REVIEW", () => {
    const entry = findById("perplexity");
    expect(entry?.capability).toBe("research.cited");
    expect(entry?.status).toBe("REVIEW");
    expect(entry?.integration_state).toBe("REFERENCE");
  });

  it("is never routed to, even when explicitly wired into the providerMap", async () => {
    const route = await routeCapability("research.cited", { perplexity: perplexityProvider });
    expect(route.outcome).toBe("NO_APPROVED_PROVIDER");
  });

  it("does not claim the existing web.research capability - it is a distinct, additive capability, not a replacement for Scrapling", () => {
    const webResearchProviders = findByCapability("web.research").map((e) => e.provider);
    expect(webResearchProviders).not.toContain("perplexity");
    expect(findByCapability("research.cited").map((e) => e.provider)).toEqual(["perplexity"]);
  });
});
