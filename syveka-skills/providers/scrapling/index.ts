import { createUnavailableStubProvider } from "../unavailable-stub.js";

/**
 * Scrapling passed its security review (PASS WITH CONDITIONS - see
 * docs/skills/SECURITY_REVIEW.md) but was never installed anywhere; that
 * review deliberately verified it via a disposable Docker container, not a
 * standing dependency. Per the product brief's explicit instruction ("Do
 * not assume it is installed unless the previous review has completed
 * successfully" - and even then, review passing is not the same as being
 * wired up), this provider stays unavailable until someone deliberately
 * connects it (e.g. runs its MCP server in the sandboxed container
 * design from docs/skills/scrapling-integration.md) and that connection
 * itself is reviewed.
 */
export const scraplingProvider = createUnavailableStubProvider({
  id: "scrapling",
  reason:
    "Scrapling passed security review but is not installed or connected in this environment. " +
    "See docs/skills/SECURITY_REVIEW.md for the review and its conditions.",
});
